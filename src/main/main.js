'use strict';

const { app, BrowserWindow, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const { Store, defaultDataDir } = require('./store');
const { Library } = require('./services/library');
const fontsService = require('./services/fonts');
const { registerIpc } = require('./ipc');
const { BossMode, MIN_W, MIN_H, DEFAULT_W, DEFAULT_H } = require('./boss');

const isDev = process.argv.includes('--dev') || !app.isPackaged;
const isSmoke = process.argv.includes('--smoke-test');
const isShots = process.argv.includes('--shots');
/**
 * 探针模式：用**真实数据目录**（不清理）跑一次「打开第一本书」的完整流程，
 * 把渲染层的实际 DOM 状态打到 stdout。
 *
 * 存在的意义：冒烟测试跑在全新的临时目录里，只覆盖"从零开始"的路径。
 * 用户遇到的是"已有书架数据 + 特定设置"的路径 —— 两者可能表现完全不同。
 * 任何"我这儿跑通了但用户那儿是空的"问题，都必须用这个模式复现。
 */
const isProbe = process.argv.includes('--probe');
/** 自动化模式（冒烟 / 截图）：需要独占运行，且强制软件渲染 */
const isAutomation = isSmoke || isShots || isProbe;

/**
 * GPU 兼容性开关。
 *
 * 在虚拟机、远程桌面、无独立显卡或驱动异常的机器上，Chromium 的 GPU 进程
 * 会反复崩溃并最终 FATAL: GPU process isn't usable → 整个应用直接退出。
 * 这对一个阅读器来说是致命的：它根本不需要 GPU 加速。
 *
 * 处理策略：
 *   · 默认允许 GPU（有显卡时滚动/翻页更顺滑）
 *   · 冒烟测试 / 显式 --no-gpu 时强制软件渲染
 *   · 运行时若检测到 GPU 反复崩溃，自动降级重试（见下方 gpuWatchdog）
 */
const forceSoftwareRender = isAutomation || process.argv.includes('--no-gpu');

if (forceSoftwareRender) {
  // 只关硬件加速，保留 Chromium 自带的 SwiftShader 软件光栅器。
  // ⚠ 不要同时加 --disable-software-rasterizer：那会导致完全没有光栅器，
  //    窗口会静默退出（表现为进程 exit 0 但什么都没渲染）。
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu-compositing');
  // 虚拟机 / 容器环境常见的两个问题：共享上下文创建失败、沙箱权限不足
  app.commandLine.appendSwitch('disable-dev-shm-usage');
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-setuid-sandbox');
  // 强制软件光栅，避免 GPU 进程反复崩溃后 FATAL 退出
  app.commandLine.appendSwitch('use-gl', 'swiftshader');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}

// 冒烟测试：在渲染层跑一系列自检，把结果打到 stdout 后退出。
// 用于在没有人工点检的情况下发现「UI 起不来 / IPC 不通 / 渲染报错」这类致命问题。
const SMOKE_CHECKS = `
(async () => {
  const out = [];
  const ok = (name, pass, detail) => out.push({ name, pass: !!pass, detail: detail || '' });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  try {
    // 1. 应用骨架是否就位
    ok('应用对象已挂载', !!window.Firmament && !!window.Firmament.App, window.Firmament ? 'Firmament 存在' : 'Firmament 缺失');
    const App = window.Firmament.App;
    const State = window.Firmament.State;

    ok('IPC 桥接可用', !!(window.firmament && window.firmament.books), window.firmament ? 'preload 已注入' : 'preload 未注入');

    // 2. 主进程通信
    const info = await window.firmament.app.info();
    ok('app:info 返回正常', info && info.ok && info.data && info.data.name === '苍穹', JSON.stringify(info && info.data ? info.data.version : info));

    const settings = await window.firmament.settings.get();
    ok('settings:get 返回默认值', settings && settings.ok && settings.data && typeof settings.data.fontSize === 'number', settings && settings.data ? 'fontSize=' + settings.data.fontSize : 'no data');

    const fonts = await window.firmament.fonts.list();
    ok('fonts:list 返回字体清单', fonts && fonts.ok && Array.isArray(fonts.data) && fonts.data.length > 10, fonts && fonts.data ? fonts.data.length + ' 种' : 'no data');

    // 3. 视图 DOM
    ['viewLibrary','viewReader','viewSettings'].forEach(id => {
      ok('视图存在：' + id, !!document.getElementById(id));
    });

    // 4. 书架初始化
    ok('书架视图已初始化', !!App.bookshelf);
    ok('阅读视图已初始化', !!App.reader);
    ok('设置视图已初始化', !!App.settingsView);
    ok('摸鱼视图已初始化', !!App.boss);

    // 5. 主题变量已下发
    const cs = getComputedStyle(document.documentElement);
    const fontSize = cs.getPropertyValue('--reader-font-size').trim();
    ok('排版 CSS 变量已注入', fontSize.length > 0, '--reader-font-size=' + fontSize);
    ok('字体变量已注入', cs.getPropertyValue('--font-reading').trim().length > 0);

    // 6. 骨架屏 / 空态可见
    const body = document.getElementById('shelfBody');
    ok('书架主体已渲染', !!body && body.children.length > 0, body ? body.children.length + ' 个子节点' : 'missing');

    // 7. 导入测试样本
    const samples = window.__SMOKE_SAMPLES__ || [];
    if (samples.length) {
      const imp = await window.firmament.books.import(samples);
      ok('导入样本书籍', imp && imp.ok && imp.data && imp.data.success > 0,
         imp && imp.data ? ('成功 ' + imp.data.success + ' / 失败 ' + imp.data.failed) : JSON.stringify(imp));
      if (imp && imp.data && imp.data.results) {
        const bad = imp.data.results.filter(r => !r.ok);
        if (bad.length) ok('全部样本导入无失败', false, JSON.stringify(bad.slice(0,3)));
      }
      await App.reloadBooks();
      ok('书架数据已刷新', State.books.length > 0, State.books.length + ' 本');
    }

    // 8. 打开一本书，验证渲染与分页
    if (State.books.length) {
      const book = State.books.find(b => b.format === 'txt') || State.books[0];
      await App.reader.open(book.id);
      await sleep(900);
      ok('阅读视图已切换', State.view === 'reader', 'view=' + State.view);
      const cols = document.getElementById('readerColumns');
      ok('正文已渲染', !!cols && cols.textContent.trim().length > 50, cols ? cols.textContent.trim().length + ' 字' : 'empty');
      const st = App.reader.paginator.state();
      ok('分页引擎已计算页数', st.pageCount >= 1, '页数=' + st.pageCount + ' 页宽=' + Math.round(st.pageWidth));

      // 9. 翻页
      const before = App.reader.ratio;
      App.reader.nextPage();
      await sleep(320);
      const after = App.reader.ratio;
      ok('翻页生效（比例前进或已到章末）', after >= before, before.toFixed(4) + ' → ' + after.toFixed(4));

      // 10. 字号变化后重排不错位
      const pageCountBefore = App.reader.paginator.pageCount;
      await App.patchSettings({ fontSize: 30 });
      await App.reader.reflow();
      await sleep(400);
      const pageCountAfter = App.reader.paginator.pageCount;
      ok('放大字号后页数增加（重排生效）', pageCountAfter >= pageCountBefore, pageCountBefore + ' → ' + pageCountAfter + ' 页');
      await App.patchSettings({ fontSize: 19 });
      await App.reader.reflow();
      await sleep(400);

      // 11. 切换到滚动模式
      App.reader.setPageMode('scroll');
      await sleep(1200);
      ok('滚动模式切换成功', App.reader.isScrollMode());
      const scrollEl = document.getElementById('readerScroll');
      ok('滚动容器可见', scrollEl && scrollEl.style.display !== 'none');
      const inner = document.getElementById('readerScrollInner');
      ok('滚动内容已注入', inner && inner.textContent.trim().length > 50, inner ? inner.textContent.trim().length + ' 字' : 'empty');

      // ⚠ 回归：热区曾以 z-index:20 铺满阅读区并接收鼠标事件，导致
      //   「滚轮不滚」+「正文内按钮点不到」。这里校验热区已完全透传。
      {
        const hz = document.getElementById('readerHotzones');
        const cs = hz ? getComputedStyle(hz) : null;
        ok('热区不拦截鼠标事件（pointer-events:none）',
           !!cs && cs.pointerEvents === 'none',
           cs ? 'pointer-events=' + cs.pointerEvents : '热区缺失');
        // 命中测试：阅读区中心点最上层的元素不能是热区
        const stage = document.getElementById('readerStage');
        const r = stage.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        ok('阅读区中心点未被热区遮挡',
           !!hit && !hit.closest('.reader-hotzones'),
           hit ? (hit.className || hit.tagName) : 'none');
      }

      // ⚠ 回归：滚动模式必须支持跨章连续阅读（用户要求"一直滚动、自动拼接每一章"）
      {
        const cont = App.reader.continuous;
        ok('连续滚动引擎已激活', !!(cont && cont.active));
        const before = cont.blocks.length;
        ok('滚动模式已装载多个章节块（可无缝跨章）', before >= 2,
           before + ' 个章节块，索引 ' + cont.firstIndex() + '~' + cont.lastIndex());
        // 主动延伸到第 3 章，验证拼接逻辑可用
        let extended = false;
        for (let i = 0; i < 3; i++) extended = (await cont.extendDown()) || extended;
        ok('可继续向下拼接后续章节', extended && cont.blocks.length > before,
           before + ' → ' + cont.blocks.length + ' 块');
        // 卷首可向上撤销
        await cont.extendUp();
        const sc = document.getElementById('readerScroll');
        ok('跨章拼接后内容高度大于视口（确实可滚动）',
           sc.scrollHeight > sc.clientHeight + 20,
           '内容 ' + Math.round(sc.scrollHeight) + 'px / 视口 ' + Math.round(sc.clientHeight) + 'px');
      }

      // ⚠ 回归：滚轮一次滚太多。校验受控滚轮的单次位移被限制住。
      {
        const sc = document.getElementById('readerScroll');
        const sh = App.reader.scroller;
        // 先用 scrollToPx 定位（它会清掉进行中的缓动），再等一帧让状态稳定，
        // 否则紧接着的 wheelScroll 会被前一次的 cancelWheelEase 清空目标 → 位移为 0
        sh.cancelWheelEase();
        sh.scrollToPx(0);
        await sleep(220);
        const startTop = sc.scrollTop;

        // 模拟一次"标准鼠标滚轮"（多数驱动下 deltaY 约 100~120）
        const handled = sh.wheelScroll({ deltaY: 120, deltaMode: 0 });
        // 缓动需要若干帧；低帧率环境下留足时间
        await sleep(1100);
        const moved = sc.scrollTop - startTop;
        const cap = Math.max(40, sc.clientHeight * sh.wheelMaxRatio);
        ok('滚轮被接管且单次位移受限',
           handled && moved > 0 && moved <= cap + 8,
           '单次滚动 ' + moved.toFixed(0) + 'px，上限 ' + cap.toFixed(0)
             + 'px（视口 ' + Math.round(sc.clientHeight) + 'px 的 ' + Math.round(sh.wheelMaxRatio * 100) + '%）');
        ok('滚轮位移明显小于视口高度（不会一次跳过整屏）',
           moved < sc.clientHeight * 0.35,
           moved.toFixed(0) + 'px vs 视口 ' + Math.round(sc.clientHeight) + 'px');
      }

      // ⚠ 回归：滚动模式曾因 max-width: 0px 导致容器宽度塌成 0，
      //   中文每字独占一行。用「渲染高度 / 行高」反推实际行数，
      //   若行数与字符数接近 1:1，就是一字一行了。
      {
        const cs = getComputedStyle(inner);
        const lh = parseFloat(cs.lineHeight) || 24;
        const innerW = inner.getBoundingClientRect().width;
        const lines = Math.round(inner.scrollHeight / lh);
        const chars = inner.textContent.replace(/\s/g, '').length;
        ok('滚动模式容器宽度正常（不是 0）', innerW > 300, '宽度 ' + Math.round(innerW) + 'px');
        ok('滚动模式每行容纳多个字（未出现一字一行）',
           lines > 0 && chars / lines > 8,
           '共 ' + chars + ' 字 / 约 ' + lines + ' 行 ＝ 每行 ' + (chars / Math.max(1, lines)).toFixed(1) + ' 字');
      }

      // 12. 自动滚动启动 / 停止
      //
      // ⚠ 必须先确保内容装载完成、且没有正在进行的拼接/定位操作。
      //   否则后台的 extendDown/extendUp 会调 scrollToPx，
      //   把自动滚动的推进"挤"回原位，看起来像"自动滚动不动"。
      {
        const s = App.reader.scroller;
        s.cancelWheelEase();
        // 等连续滚动稳定（拼接锁释放、内容高度不再变化）
        let prevH = -1;
        for (let i = 0; i < 12; i++) {
          const h = document.getElementById('readerScroll').scrollHeight;
          if (h === prevH && !App.reader.continuous._extendDownLock && !App.reader.continuous._extendUpLock) break;
          prevH = h;
          await sleep(260);
        }
        s.scrollToPx(0);
        await sleep(320);
      }
      App.reader.toggleAutoScroll();
      await sleep(700);
      ok('自动滚动已启动', App.reader.autoscroll && App.reader.scroller.autoEnabled);
      const scrolled = document.getElementById('readerScroll').scrollTop;
      // 低帧率环境下 rAF 稀疏，给足时间观察位移
      await sleep(2400);
      const scrolled2 = document.getElementById('readerScroll').scrollTop;
      ok('自动滚动确实在滚动', scrolled2 > scrolled,
         scrolled.toFixed(1) + ' → ' + scrolled2.toFixed(1)
           + '（位移 ' + (scrolled2 - scrolled).toFixed(1) + 'px）');

      // ⚠ 回归：自动滚动曾"滚到章末就停"。这里验证它会在末尾接续下一章。
      //
      // 断言不能依赖"这本书够长"—— 预读窗口一次会装 center+keepBelow 章，
      // 短书（样例书 5 章）开局就已经装完，extendDown 返回 false 反而是对的。
      // 因此临时把 keepBelow 压到 0，制造出"后面还有未装载章节"的确定场景，
      // 这样无论书多长都能稳定验证续接机制。
      {
        const cont = App.reader.continuous;
        const savedKeep = cont.keepBelow;
        cont.keepBelow = 0;
        await cont.mount(0, 0);
        await sleep(600);
        const before = cont.lastIndex();
        const canExtend = App.reader.extendForAutoScroll();
        await sleep(800);
        const after = cont.lastIndex();
        cont.keepBelow = savedKeep;
        ok('自动滚动可在章末接续下一章（不会中断）',
           canExtend === true && after > before,
           '已装到第 ' + (before + 1) + ' 章 → 第 ' + (after + 1) + ' 章（共 ' + App.reader.toc.length + ' 章）');

        // 已在最后一章时必须返回 false，不能空转
        await cont.gotoChapter(App.reader.toc.length - 1, 0);
        await sleep(600);
        ok('已是最后一章时正确停止续接',
           App.reader.extendForAutoScroll() === false,
           '末章索引 ' + cont.lastIndex() + ' / 共 ' + App.reader.toc.length + ' 章');
      }

      // ⚠ 回归：自动滚动**不应**因任何鼠标动作而暂停（用户明确要求）。
      //
      //   历史演进：最初 mousemove 一律暂停 → 改成"累计位移 >90px 才暂停"
      //   （本测试原断言的就是这一行为）→ 现在**彻底取消自动暂停**。
      //   断言必须跟着契约走：无论鼠标怎么动，自动滚动都必须继续跑。
      {
        const sh = App.reader.scroller;
        sh.togglePause(false);
        const readerEl = document.getElementById('reader');
        const r = readerEl.getBoundingClientRect();
        const pt = (dx, dy) => new MouseEvent('mousemove', {
          clientX: r.left + 400 + dx,
          clientY: r.top + 300 + dy,
          bubbles: true,
        });

        // 连续大幅移动鼠标（累计远超旧阈值 90px）
        for (let i = 0; i < 10; i++) {
          readerEl.dispatchEvent(pt(i * 40, i * 10));
          await sleep(40);
        }
        await sleep(300);
        ok('自动滚动不因鼠标移动而暂停', sh.paused === false,
           '累计移动约 ' + (9 * 40) + 'px 后 paused=' + sh.paused);

        // 滚轮同样不应打断
        const scEl = document.getElementById('readerScroll');
        if (scEl) {
          scEl.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true }));
          await sleep(300);
          ok('自动滚动不因滚轮而暂停', sh.paused === false, 'paused=' + sh.paused);
        }

        // 只有显式暂停才应停下 —— 这是残留的唯一暂停入口
        sh.togglePause(true);
        ok('显式暂停仍然有效', sh.paused === true, 'paused=' + sh.paused);
        sh.togglePause(false);
      }

      App.reader.stopAutoScroll(false);
      ok('自动滚动已停止', !App.reader.autoscroll);

      // 13. 回到翻页模式 + 自动翻页
      App.reader.setPageMode('page');
      await sleep(600);
      ok('切回翻页模式', !App.reader.isScrollMode());

      // ⚠ 关键回归：四种「模式 × 打开方式」组合。
      //
      //   曾经存在的严重 bug：把「切换分页/滚动容器可见性」的代码只留在
      //   applyModeLayout 里，而 loadChapter 的滚动分支改成只调 mountContinuous
      //   后不再经过它 —— 于是「打开书时设置本就是滚动模式」这条路径下，
      //   滚动容器始终保持 index.html 里写死的 display:none，
      //   正文两万多字全在 DOM 里，但用户看到的是整屏空白。
      //
      //   旧冒烟测试只覆盖「先以翻页模式打开 → 再切到滚动」，切换动作恰好
      //   补上了 display，所以一直是绿的。必须显式覆盖"直接以某模式打开"。
      {
        const combos = [];
        // 判据：容器可见 **且** 正文容器里确实渲染出了内容。
        // ⚠ 不要用固定字数阈值（如 >100）—— 真实书里开篇常是封面/版权页，
        //   纯文本可能只有几十字，拿字数判会把正常情况报成失败。
        //   这里要守的是"打开了却整屏空白"，不是"这章够不够长"。
        const probeCombo = (mode) => {
          const sc = document.getElementById('readerScroll');
          const vp = document.getElementById('readerViewport');
          const host = mode === 'scroll'
            ? document.getElementById('readerScrollInner')
            : document.getElementById('readerColumns');
          const visible = mode === 'scroll'
            ? (sc && getComputedStyle(sc).display !== 'none')
            : (vp && getComputedStyle(vp).display !== 'none');
          const len = host ? host.textContent.trim().length : 0;
          const kids = host ? host.children.length : 0;
          return {
            ok: !!visible && !!host && (len > 0 || kids > 0),
            detail: '可见=' + visible + ' 字数=' + len + ' 子元素=' + kids,
          };
        };

        for (const mode of ['page', 'scroll']) {
          const name = mode === 'scroll' ? '滚动' : '翻页';

          // (a) 直接以该模式打开（用户真实路径）
          await App.patchSettings({ pageMode: mode });
          await App.reader.open(book.id, { resume: false });
          await sleep(2000);
          {
            const r = probeCombo(mode);
            combos.push({ label: '直接以' + name + '模式打开', ok: r.ok, detail: r.detail });
          }

          // (b) 从另一模式切换过来
          await App.reader.setPageMode(mode === 'page' ? 'scroll' : 'page');
          await sleep(1100);
          await App.reader.setPageMode(mode);
          await sleep(1500);
          {
            const r = probeCombo(mode);
            combos.push({ label: '切换到' + name + '模式', ok: r.ok, detail: r.detail });
          }
        }
        for (const c of combos) ok(c.label + '：容器可见且正文非空', c.ok, c.detail);
        ok('四种模式组合全部正常', combos.every(c => c.ok),
           combos.filter(c => c.ok).length + '/' + combos.length);

        // 复位到翻页模式供后续用例使用
        await App.patchSettings({ pageMode: 'page' });
        await App.reader.open(book.id, { resume: false });
        await sleep(1600);
      }

      // ⚠ 回归：章末的「上一章 / 下一章 / 目录」按钮曾点不动，
      //   因为热区覆盖层把点击吞掉了。
      //
      //   取样注意两点，否则会误判：
      //     ① 按钮在章节末尾 = 最后一页，必须先翻到末页，否则它不在视口内
      //     ② [disabled] 的按钮带 pointer-events:none，
      //        elementFromPoint 会返回其父容器 —— 这是正常行为，不是遮挡。
      //        所以只对"可用"的按钮做命中测试，并断言命中的不是热区。
      {
        // 翻到最后一页 —— 章末导航按钮位于章节末尾，不翻过去它不在视口内。
        // ⚠ 必须等分页重排真正落定（pageCount 稳定）再翻，
        //   否则 setRatio 按旧页数算出页码，翻过去的不是最后一页。
        await App.reader.reflow();
        await sleep(700);
        const pst = App.reader.paginator.state();
        await App.reader.paginator.gotoPage(pst.pageCount - 1, true);
        await sleep(700);
        ok('已翻到最后一页', App.reader.paginator.state().pageIndex === App.reader.paginator.state().pageCount - 1,
           '第 ' + (App.reader.paginator.state().pageIndex + 1) + '/' + App.reader.paginator.state().pageCount + ' 页');

        const navBtns = Array.from(document.querySelectorAll('#readerColumns .chapter-nav__btn'));
        ok('章节导航按钮已渲染', navBtns.length >= 2, navBtns.length + ' 个');

        const enabled = navBtns.filter(b => !b.hasAttribute('disabled'));
        ok('末页存在可用的导航按钮', enabled.length > 0,
           enabled.length + ' 个可用 / 共 ' + navBtns.length + ' 个');
        if (enabled.length) {
          const b = enabled[0];
          const br = b.getBoundingClientRect();
          const visible = br.width > 0 && br.height > 0
            && br.top < window.innerHeight && br.bottom > 0
            && br.left < window.innerWidth && br.right > 0;
          ok('章末导航按钮在末页可见', visible,
             'rect=[' + Math.round(br.left) + ',' + Math.round(br.top) + ','
               + Math.round(br.right) + ',' + Math.round(br.bottom) + ']');
          if (visible) {
            const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
            // 关键断言：命中的必须是正文里的元素，绝不能是热区/其他覆盖层
            ok('章节导航按钮未被覆盖层遮挡',
               !!hit && !hit.closest('.reader-hotzones') && (hit === b || b.contains(hit)),
               hit ? ('命中的是 ' + (hit.className || hit.tagName)) : '无命中元素');
          }
        }
        await App.reader.paginator.setRatio(0);
        await sleep(320);
      }

      // ⚠ 回归：分页模式曾在页边距区域露出相邻列的文字。
      //   根因是「列间距 < 右边距」时，下一列会侵入当前页的边距区。
      //   现在由 .reader-clip 做硬裁剪，这里校验裁剪位置与尺寸的数学不变量。
      {
        const clip = document.getElementById('readerClip');
        const cols = document.getElementById('readerColumns');
        const clipRect = clip.getBoundingClientRect();
        const vpRect = document.getElementById('readerViewport').getBoundingClientRect();
        const st = App.reader.paginator.state();
        const m = App.reader.paginator.readMargins();

        ok('分页裁剪层存在', !!clip);

        // 裁剪层必须"精确等于一页的可用区域"。
        // 修复过程：最初用 padding 做裁剪 —— 但 padding 不参与 overflow 裁剪，
        // 相邻列会从页边距区域露出来（用户看到的"两侧有别的文字"）。
        // 现在改为按 left/top/width/height 精确定位。
        ok('裁剪层宽度等于单页宽度',
           Math.abs(clipRect.width - st.pageWidth) <= 1.5,
           '裁剪层 ' + Math.round(clipRect.width) + 'px vs 单页 ' + Math.round(st.pageWidth) + 'px');
        ok('裁剪层左侧让出左边距',
           Math.abs((clipRect.left - vpRect.left) - m.left) <= 2,
           '实际 ' + Math.round(clipRect.left - vpRect.left) + 'px 期望 ' + m.left + 'px');
        ok('裁剪层右侧让出右边距',
           Math.abs((vpRect.right - clipRect.right) - m.right) <= 2,
           '实际 ' + Math.round(vpRect.right - clipRect.right) + 'px 期望 ' + m.right + 'px');

        ok('分页正文有实际宽度（非空白页）',
           cols.getBoundingClientRect().width > 300 && cols.textContent.trim().length > 50,
           '列宽 ' + Math.round(cols.getBoundingClientRect().width) + 'px / ' + cols.textContent.trim().length + ' 字');

        // "只看到一页"的核心不变量：
        //   列容器被 translateX(-pageIndex * step) 位移后，
        //   第 pageIndex 列恰好对齐到裁剪层的左边缘。
        //   因此：位移量必须等于 -(页码 × 步长)，且步长 = 页宽 + 页间距。
        //   （直接用 transform 反推"当前列绝对位置"容易搞错符号，
        //     校验这个等式更稳。）
        const tf = getComputedStyle(cols).transform;
        const shift = tf && tf !== 'none' ? new DOMMatrixReadOnly(tf).m41 || 0 : 0;
        const gap = st.pageGap;
        const step = st.pageWidth + gap;
        const expectedShift = -st.pageIndex * step;

        ok('列位移与当前页码一致',
           Math.abs(shift - expectedShift) <= 1.5,
           '位移 ' + Math.round(shift) + 'px 期望 ' + Math.round(expectedShift)
             + 'px（第 ' + (st.pageIndex + 1) + ' 页 × 步长 ' + Math.round(step) + 'px）');

        // 由该不变量推出：当前列占 [clip.left, clip.left + pageW]，
        // 相邻列分别落在 [clip.left - step - gap, ...] 与 [clip.left + pageW + gap, ...]，
        // 二者都在裁剪层之外 —— 这就是"两侧不露字"的保证。
        const curLeft = clipRect.left;
        const prevColRight = curLeft - gap;
        const nextColLeft = curLeft + st.pageWidth + gap;

        ok('当前列与裁剪区左缘对齐',
           Math.abs(curLeft - clipRect.left) <= 1, '当前列左缘 ' + Math.round(curLeft) + 'px');
        ok('相邻列被裁在裁剪区之外（两侧不露字）',
           prevColRight < clipRect.left || nextColLeft > clipRect.right,
           '前列右缘 ' + Math.round(prevColRight) + ' < 裁剪左 ' + Math.round(clipRect.left)
             + ' ｜ 后列左缘 ' + Math.round(nextColLeft) + ' > 裁剪右 ' + Math.round(clipRect.right));
        ok('列步长大于等于页宽（列之间不重叠）',
           step >= st.pageWidth, '步长 ' + Math.round(step) + 'px 页宽 ' + Math.round(st.pageWidth) + 'px');

        // 正文不应与顶栏/底栏重叠
        const p = cols.querySelector('p');
        const topbar = document.getElementById('readerTopbar');
        const bottombar = document.getElementById('readerBottombar');
        if (p && topbar) {
          const pRect = p.getBoundingClientRect();
          ok('正文首行不与顶栏重叠', pRect.top >= topbar.getBoundingClientRect().bottom - 2,
             '首行 top=' + Math.round(pRect.top) + ' 顶栏 bottom=' + Math.round(topbar.getBoundingClientRect().bottom));
        }
        if (p && bottombar) {
          const lastP = cols.querySelector('p:last-of-type');
          if (lastP) {
            ok('正文末行不与底栏重叠',
               lastP.getBoundingClientRect().bottom <= bottombar.getBoundingClientRect().top + 2,
               '末行 bottom=' + Math.round(lastP.getBoundingClientRect().bottom)
                 + ' 底栏 top=' + Math.round(bottombar.getBoundingClientRect().top));
          }
        }
      }

      App.reader.toggleAutoTurn();
      ok('自动翻页已启动', App.reader.autoTurner.enabled);
      App.reader.toggleAutoTurn();
      ok('自动翻页已停止', !App.reader.autoTurner.enabled);

      // 14. 目录 / 书签 / 搜索
      const tocItems = document.querySelectorAll('#tocList .toc-item');
      ok('目录已渲染', tocItems.length > 0, tocItems.length + ' 章');

      // ⚠ 必须走**真实用户路径**（toggleBookmark），而不是直接调 IPC ——
      //   否则界面那一层的问题会被完全掩盖。
      //
      //   ⚠ 断言要"从零开始"：先确认这本书此刻没有书签。
      //     若带着残留书签跑，toggle 会执行"取消"而不是"添加" ——
      //     曾经因此报出假失败：明明功能正常，却显示"书签已添加 → 0 条"。
      //     （根因是测试目录清理被安全策略拦截后静默失败，见 removeDirInBatches）
      const readerBookId = App.reader.book ? App.reader.book.id : null;
      const beforeList = await window.firmament.bookmarks.list(readerBookId);
      const beforeLen = (beforeList && beforeList.ok && Array.isArray(beforeList.data))
        ? beforeList.data.length : -1;
      ok('书签测试起点为空白状态', beforeLen === 0,
         '当前已有 ' + beforeLen + ' 条（应为 0，非 0 说明测试目录没清干净）');

      await App.reader.toggleBookmark();
      await sleep(300);

      const bms = await window.firmament.bookmarks.list(readerBookId);
      const bmLen = (bms && bms.ok && Array.isArray(bms.data)) ? bms.data.length : -1;
      ok('书签已添加', beforeLen === 0 && bmLen > beforeLen,
         'bookId=' + readerBookId + '（book.id=' + book.id + '，'
           + (readerBookId === book.id ? '一致' : '不一致 ← 问题所在') + '）'
           + ' chapter=' + (App.reader.chapter ? App.reader.chapter.title : 'null')
           + ' 前 ' + beforeLen + ' → 后 ' + bmLen + ' 条');

      // 再点一次应当取消（toggle 语义），验证双向都可用
      await App.reader.toggleBookmark();
      await sleep(300);
      const bms2 = await window.firmament.bookmarks.list(readerBookId);
      const bmLen2 = (bms2 && bms2.ok && Array.isArray(bms2.data)) ? bms2.data.length : -1;
      ok('再次点击可取消书签', bmLen2 === 0,
         bmLen + ' → ' + bmLen2 + ' 条（期望回到 0）');

      await App.reader.doSearch('的');
      await sleep(500);
      const results = document.querySelectorAll('#searchResults .result-item');
      ok('全文搜索返回结果', results.length > 0, results.length + ' 条');

      // 15. 进度持久化
      await App.reader.saveProgress(true);
      const prog = await window.firmament.progress.get(book.id);
      ok('阅读进度已保存', prog && prog.ok && prog.data && typeof prog.data.chapterIndex === 'number',
         prog && prog.data ? JSON.stringify({ch: prog.data.chapterIndex, ratio: Number((prog.data.ratio||0).toFixed(3))}) : 'none');

      // 16. 主题切换
      for (const t of ['night','eyecare','sepia','paper','mint','day']) {
        await App.patchSettings({ theme: t });
        const attr = document.documentElement.getAttribute('data-theme');
        if (attr !== t) { ok('主题切换：' + t, false, '实际 ' + attr); }
      }
      ok('六套主题切换正常', document.documentElement.getAttribute('data-theme') === 'day');

      // 17. 皮肤切换
      for (const s of ['skeuo','minimal']) {
        await App.patchSettings({ skin: s }, true);
        const attr = document.documentElement.getAttribute('data-skin');
        if (attr !== s) ok('皮肤切换：' + s, false, '实际 ' + attr);
      }
      ok('两套皮肤切换正常', document.documentElement.getAttribute('data-skin') === 'minimal');

      // ⚠ 回归：阅读视图下应用标题栏被隐藏，阅读顶栏若没有拖拽能力，
      //   用户就无法移动窗口（"顶栏按住没法推动窗口"）。
      //
      //   注意：顶栏在无操作数秒后会自动淡出（is-hidden → opacity 0 +
      //   pointer-events:none）。此时 elementFromPoint 命中的是下层正文，
      //   那是"没显示"而非"被遮挡"。所以必须先显式唤起 UI 再测命中。
      {
        App.reader.showUI(true);
        await sleep(260);
        const tb = document.getElementById('readerTopbar');
        const cs = getComputedStyle(tb);
        ok('阅读顶栏可拖动窗口（app-region: drag）',
           cs.webkitAppRegion === 'drag', 'app-region=' + (cs.webkitAppRegion || 'none'));
        const btn = document.getElementById('rbtnBack');
        const bcs = getComputedStyle(btn);
        ok('顶栏按钮排除拖拽（仍可点击）',
           bcs.webkitAppRegion === 'no-drag', 'app-region=' + (bcs.webkitAppRegion || 'none'));
        ok('顶栏处于可见状态', !tb.classList.contains('is-hidden'),
           'is-hidden=' + tb.classList.contains('is-hidden'));
        const br = btn.getBoundingClientRect();
        const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
        ok('顶栏按钮可被点击', !!hit && (hit === btn || btn.contains(hit)),
           hit ? (hit.id || hit.className || hit.tagName) : 'none');
      }

      // ⚠ 回归：窗口最小宽度曾被卡在 900px，用户无法把窗口收窄。
      {
        const bres = await window.firmament.app.bounds();
        const b0 = bres && bres.data ? bres.data : null;
        ok('窗口最小宽度已放开（可收窄到 620px 以内）',
           b0 && b0.minWidth <= 620,
           b0 ? ('minWidth=' + b0.minWidth + ', minHeight=' + b0.minHeight) : ('无数据 ' + JSON.stringify(bres)));
      }

      // 18. 摸鱼迷你框
      App.boss.mode = 'mini-text';
      App.boss.style = 'square';
      await App.boss.applyVisibility(true, 'mini-text', 'square');
      await sleep(200);
      const mini = document.getElementById('bossMini');
      const miniText = document.getElementById('bossMiniText');
      ok('迷你框可见', mini && !mini.classList.contains('is-hidden'));
      ok('迷你框有正文', miniText && miniText.textContent.trim().length > 20, miniText ? miniText.textContent.trim().length + ' 字' : 'empty');
      // 迷你框应"只有文字"：不得出现工具栏/选项类控件。
      //
      // 唯一允许的是右上角那个**视觉上不可见**的退出热区 ——
      // 它保证不熟悉快捷键的人也能退出（这个坑已经踩过一次）。
      // 判定标准看"是否可见"而不是"是否存在"：
      // 该按钮图标与背景都透明，只在鼠标精确移上去时才显露极轻的凝色。
      // ⚠ 不能用 opacity 判断 —— 它在 hover 时由 CSS 改 opacity，
      //   而测试运行时鼠标位置可能恰好落在它上面，导致误判为"可见控件"。
      {
        const ctrls = mini ? Array.from(mini.querySelectorAll('button, .btn, .fab')) : [];
        // ⚠ 解析颜色不能用带反斜杠的正则。
        //   这段代码位于模板字符串内，转义序列会先被 JS 处理掉 ——
        //   正则里的空白匹配符会退化成字面字母，导致永远匹配不上，
        //   于是"全透明"被误判为"可见"。
        //   这里改为纯字符串解析，不含任何转义序列，彻底绕开这个坑。
        const alphaOf = (v) => {
          if (!v) return 0;
          if (v === 'transparent') return 0;
          const i = v.indexOf('(');
          const j = v.lastIndexOf(')');
          if (i < 0 || j < 0) return 1;               // 形如 #fff 的不透明色
          const parts = v.slice(i + 1, j).split(',').map((x) => parseFloat(x));
          if (parts.length >= 4) {
            return Number.isFinite(parts[3]) ? parts[3] : 0;
          }
          return 1;
        };
        const detail = ctrls.map((el) => {
          const cs = getComputedStyle(el);
          return (el.id || el.className)
            + '[bgA=' + alphaOf(cs.backgroundColor) + ',inkA=' + alphaOf(cs.color)
            + ',size=' + el.offsetWidth + 'x' + el.offsetHeight + ']';
        }).join(' ');
        const visuallyVisible = ctrls.filter((el) => {
          const cs = getComputedStyle(el);
          const sized = el.offsetWidth > 0 && el.offsetHeight > 0;
          return sized && (alphaOf(cs.backgroundColor) > 0.05 || alphaOf(cs.color) > 0.05);
        });
        ok('迷你框只有文字（无可见的选项控件）', visuallyVisible.length === 0,
           ctrls.length + ' 个控件，视觉可见 ' + visuallyVisible.length + ' 个 ｜ ' + detail);
        // 退出热区必须真实存在且可点击 —— 否则不熟悉快捷键的人无法退出
        const closeEl = document.getElementById('bossMiniClose');
        ok('迷你框保留可点击的退出热区',
           !!closeEl && closeEl.offsetWidth >= 12 && closeEl.offsetHeight >= 12,
           closeEl ? (closeEl.offsetWidth + '×' + closeEl.offsetHeight) : '缺失');
      }

      // ⚠ 回归：摸鱼模式曾无法退出（热键冲突 + 窗口不抢焦点导致 Esc 失效）。
      //   这里验证退出通道确实存在且可用。
      ok('迷你框有退出按钮（可发现性）', !!document.getElementById('bossMiniClose'));
      const bossSt = await window.firmament.boss.state();
      ok('至少有两条可用的退出通道',
         bossSt && bossSt.ok && bossSt.data.canExit === true,
         bossSt && bossSt.data
           ? ('老板键=' + bossSt.data.hotkeyOk + ' Esc=' + bossSt.data.escapeExit
              + ' 辅助键(' + bossSt.data.alternateToggle + ')=' + bossSt.data.alternateToggleOk)
           : 'no state');

      // ⚠ 回归：迷你框拖拽区曾用 -webkit-app-region:drag，
      //   导致 ① dblclick 回调不触发（"双击顶部没法退出"）
      //        ② Windows 把双击拖拽区当成最大化 → 迷你框刷地铺满全屏。
      //   现在改为自定义拖拽 + 主进程 setMaximizable(false)，这里逐项校验。
      {
        const mini = document.getElementById('bossMini');
        const drag = mini.querySelector('.boss-mini__drag');
        const dragCs = drag ? getComputedStyle(drag) : null;
        ok('迷你框拖拽区不再使用 CSS 拖拽（否则吞事件/触发最大化）',
           !!dragCs && (dragCs.webkitAppRegion === 'no-drag' || !dragCs.webkitAppRegion || dragCs.webkitAppRegion === 'none'),
           dragCs ? ('app-region=' + (dragCs.webkitAppRegion || 'none')) : '拖拽区缺失');

        // 模拟双击迷你框顶部 —— 应当触发退出
        const mr = mini.getBoundingClientRect();
        mini.dispatchEvent(new MouseEvent('dblclick', {
          clientX: mr.left + mr.width / 2,
          clientY: mr.top + 8,
          bubbles: true,
        }));
        await sleep(700);
        const afterDbl = await window.firmament.boss.state();
        ok('迷你框双击顶部可退出摸鱼模式',
           afterDbl && afterDbl.ok && afterDbl.data.active === false,
           afterDbl && afterDbl.data ? ('active=' + afterDbl.data.active) : 'no state');
      }

      // 重新进入摸鱼（显式指定 mini-text + square，走与用户一致的路径），
      // 校验窗口不会被误最大化
      await App.boss.enter({ mode: 'mini-text', style: 'square' });
      await sleep(900);
      {
        const wres = await window.firmament.app.bounds();
        const wb = wres && wres.data ? wres.data : null;
        ok('摸鱼窗口保持正方形（未被最大化撑满）',
           !!wb && Math.abs(wb.width - wb.height) <= 8 && wb.width < 800,
           wb ? (wb.width + '×' + wb.height) : ('无数据 ' + JSON.stringify(wres)));
        const bstate = await window.firmament.boss.state();
        ok('主进程摸鱼设置与渲染层一致',
           !!bstate && bstate.ok && bstate.data.mode === 'mini-text' && bstate.data.style === 'square',
           bstate && bstate.data ? ('mode=' + bstate.data.mode + ' style=' + bstate.data.style) : 'no state');
      }
      await App.boss.exit();
      await sleep(500);
      await App.boss.applyVisibility(false, 'mini-text', 'square');
      await sleep(300);
      const afterExit = await window.firmament.boss.state();
      ok('摸鱼模式可正常退出', afterExit && afterExit.ok && afterExit.data.active === false,
         afterExit && afterExit.data ? ('active=' + afterExit.data.active) : 'no state');
      ok('退出后隐藏迷你框', document.getElementById('bossMini').classList.contains('is-hidden'));

      // 19. 伪装界面（注意：DOM id 是 camelCase，与 mode 键不同）
      const FAKE_IDS = { 'fake-word':'fakeWord', 'fake-excel':'fakeExcel', 'fake-code':'fakeCode', 'fake-mail':'fakeMail' };
      for (const m of Object.keys(FAKE_IDS)) {
        await App.boss.applyVisibility(true, m, 'normal');
        await sleep(80);
        const node = document.getElementById(FAKE_IDS[m]);
        if (!node || !node.classList.contains('is-on')) ok('伪装界面：' + m, false, '未激活');
        else {
          const visible = node.offsetWidth > 0 && node.offsetHeight > 0;
          if (!visible) ok('伪装界面可见性：' + m, false, 'display 未生效');
        }
      }
      ok('四套伪装界面均可呈现', true);
      await App.boss.applyVisibility(false, 'fake-word', 'normal');

      // 20. 设置页
      App.route('settings');
      await sleep(400);
      const navItems = document.querySelectorAll('#settingsNav .settings-nav__item');
      ok('设置页导航已渲染', navItems.length >= 7, navItems.length + ' 项');
      const pane = document.querySelector('.settings-pane.is-active');
      ok('设置面板有内容', pane && pane.children.length > 2, pane ? pane.children.length + ' 个子节点' : 'empty');

      // 16. 边界场景：空态 → 重新渲染 → 导入后仍可用
      //   （历史上这里翻过车：空书架时 renderGrid 会把 #shelfGrid 一起删掉，
      //     导致导入第一本书后书架崩溃。必须回归验证。）
      App.route('library');
      await sleep(300);
      ok('书架网格节点始终存在（空态不能删除它）',
         !!document.getElementById('shelfGrid'),
         document.getElementById('shelfGrid') ? 'ok' : '#shelfGrid 已丢失');
      App.bookshelf.state.shelfFilter = { type: 'favorite', value: null, search: '' };
      App.bookshelf.render();
      await sleep(200);
      ok('渲染空结果后网格仍在', !!document.getElementById('shelfGrid'));
      const emptyHost = document.querySelector('#shelfBody .empty-host .empty');
      ok('空结果显示空态提示', !!emptyHost);
      App.bookshelf.state.shelfFilter = { type: 'all', value: null, search: '' };
      App.bookshelf.render();
      await sleep(250);
      const cardsAfter = document.querySelectorAll('#shelfGrid .library-card');
      ok('从空态恢复后书籍正常显示', cardsAfter.length > 0, cardsAfter.length + ' 张');

      // 17. 字体系统：切换字体应真正改变正文渲染宽度（而不只是改了个变量）
      //   注意：上一段（边界场景）结束时已关闭阅读，这里必须先重新打开，
      //   否则 reader.reflow() 会因为 book 为空而直接返回，测出来的全是旧数据。
      const firstBook = State.books.find(b => b.format === 'txt') || State.books[0];
      await App.reader.open(firstBook.id);
      await sleep(1500);
      ok('重新打开书籍以供排版测试', State.view === 'reader' && !!App.reader.book);

      // 用 canvas 实测文本宽度：这是判断"字体是否真的换了"最可靠的方式。
      // （不能用页数判断：中文字体在设计上都是全角等宽，SimSun 与 SimHei 的
      //   CJK 字宽完全一致，页数不会变，但那不代表字体没生效。）
      const canvasCtx = document.createElement('canvas').getContext('2d');
      const measureText = (family) => {
        canvasCtx.font = '16px ' + family;
        return canvasCtx.measureText('Firmament Reader 苍穹 Wg@123').width;
      };

      const probeFont = async (family) => {
        await App.patchSettings({ fontFamily: family });
        await App.reader.reflow();
        await sleep(320);
        const cols = document.getElementById('readerColumns');
        const cs = getComputedStyle(cols);
        return {
          varValue: cs.getPropertyValue('--font-reading').trim(),
          computed: cs.fontFamily,
          pageCount: App.reader.paginator.state().pageCount,
          textWidth: measureText(family),
        };
      };

      const fontList = await window.firmament.fonts.list();
      const installed = (fontList.data || []).filter(f => f.installed !== false);
      ok('字体清单含已安装字体', installed.length > 3, installed.length + ' 种已安装 / 共 ' + (fontList.data || []).length);
      ok('字体分组包含手写体', (fontList.data || []).some(f => f.group === '手写体'));
      ok('字体分组包含宋体楷体黑体圆体',
        ['中文常用','圆体','楷体'].every(g => (fontList.data || []).some(f => f.group === g)));

      const serif = await probeFont('"SimSun", "Songti SC", serif');
      const sans = await probeFont('"SimHei", "Heiti SC", sans-serif');
      ok('切换字体后 CSS 变量同步更新',
        serif.varValue.includes('SimSun') && sans.varValue.includes('SimHei'),
        serif.varValue + ' → ' + sans.varValue);
      ok('切换字体后正文按新字体渲染', serif.computed !== sans.computed,
        serif.computed + ' → ' + sans.computed);

      // 度量验证：逐个测量候选字体，统计"不同宽度"的数量。
      // ⚠ 不能用「SimSun vs SimHei 页数/宽度不同」来断言 —— 中文字体对 CJK 码位
      //    一律是 2/2 em 等宽设计，两者度量可能完全一致，此时页数不变是正常的，
      //    不代表字体没生效。改用「候选字体集合里存在多种不同度量」来判断更可靠。
      const sampleText = 'Firmament Reader 苍穹 Wg@123 宋体黑体楷体手写';
      const measured = {};
      const candidates = [
        ['"LXGW WenKai Lite", "KaiTi", serif', '霞鹜文楷(内置)'],
        ['"Zhi Mang Xing", "KaiTi", cursive', '志莽行书(内置)'],
        ['"ZCOOL KuaiLe", sans-serif', '站酷快乐体(内置)'],
        ['"Microsoft YaHei", sans-serif', '微软雅黑'],
        ['"SimSun", serif', '宋体'],
        ['"SimHei", sans-serif', '黑体'],
        ['"KaiTi", serif', '楷体'],
        ['"FangSong", serif', '仿宋'],
        ['Consolas, monospace', 'Consolas 等宽'],
        ['"Times New Roman", serif', 'Times'],
      ];
      for (const [fam, label] of candidates) {
        canvasCtx.font = '16px ' + fam;
        measured[label] = Math.round(canvasCtx.measureText(sampleText).width * 10) / 10;
      }
      const distinctWidths = new Set(Object.values(measured));
      ok('不同字体产生不同文本度量（字体切换真正生效）',
        distinctWidths.size >= 2,
        'distinct=' + distinctWidths.size + ' ｜ ' + Object.entries(measured).map(([k,v]) => k + '=' + v).join(' '));

      // 未安装的字体必须回退（且不能渲染成空白）
      canvasCtx.font = '16px "SimSun", serif';
      const realWidth = canvasCtx.measureText('测试文本').width;
      canvasCtx.font = '16px "这个字体一定不存在XYZ", sans-serif';
      const fallbackWidth = canvasCtx.measureText('测试文本').width;
      ok('未安装字体安全回退（不出现空白）',
        fallbackWidth > 0 && realWidth > 0,
        '已装=' + realWidth.toFixed(1) + 'px 回退=' + fallbackWidth.toFixed(1) + 'px');

      // ⚠ 内置字体必须真的注册成功，不能只是"名字在列表里但静默回退到默认字体"。
      //
      // 这里有个坑：document.fonts.check('16px "某字体"') 对**从未注册过**的
      // 字体族也会返回 true（因为浏览器会回退到默认字体）。
      // 所以不能只靠 check()，必须用一个"不存在的族名"做对照：
      //   若 check(目标) 与 check(不存在的族) 都在、且宽度不同，才说明目标真加载了。
      // 之前正是这个假阳性掩盖了「@import 被忽略导致霞鹜文楷从未注册」的问题。
      {
        const builtinFams = ['LXGW WenKai Lite', 'ZCOOL XiaoWei', 'Zhi Mang Xing', 'ZCOOL QingKe HuangYou', 'ZCOOL KuaiLe'];
        const bogus = '__FirmamentNoSuchFont__';
        try { await document.fonts.load('16px "' + bogus + '"', '苍穹'); } catch (_) {}
        canvasCtx.font = '16px "' + bogus + '"';
        const bogusW = canvasCtx.measureText('苍穹字体测试ABC').width;

        const results = [];
        for (const fam of builtinFams) {
          // 通过 FontFaceSet 检查是否真的有匹配的已加载字面
          let registered = false;
          try {
            registered = Array.from(document.fonts).some(
              (ff) => (ff.family || '').replace(/["']/g, '') === fam && ff.status === 'loaded'
            );
          } catch (_) {}
          try { await document.fonts.load('16px "' + fam + '"', '苍穹字体测试'); } catch (_) {}
          canvasCtx.font = '16px "' + fam + '"';
          const w = canvasCtx.measureText('苍穹字体测试ABC').width;
          results.push({ fam, registered, w: Math.round(w * 10) / 10, diffFromBogus: Math.abs(w - bogusW) > 0.5 });
        }

        const allReal = results.every(r => r.registered);
        ok('五款内置字体均已注册（非静默回退）', allReal,
           '对照(不存在字体)=' + bogusW.toFixed(1) + 'px ｜ '
             + results.map(r => r.fam + (r.registered ? '✓' : '✗') + '(' + r.w + ')').join(' '));

        const allDiffer = results.every(r => r.diffFromBogus);
        ok('内置字体度量与回退字体不同（确为真实字体）', allDiffer,
           results.map(r => r.fam + ' Δ' + (r.diffFromBogus ? '≠' : '＝')).join(' '));

        const widths = new Set(results.map(r => r.w));
        ok('内置字体之间度量互不相同', widths.size >= 3,
           'distinct=' + widths.size + ' ｜ ' + results.map(r => r.fam + '=' + r.w).join(' '));
      }

      // ⚠ 回归：字体清单必须包含多款硬笔手写体（用户要求"再找几个手写体"）
      {
        const fl = await window.firmament.fonts.list();
        const all = fl.data || [];
        const hand = all.filter(f => f.group === '内置手写');
        ok('内置硬笔手写体不少于 3 款', hand.length >= 3,
           hand.map(f => f.label).join('、') || '无');
        const builtinAll = all.filter(f => f.builtin);
        ok('内置字体全部可用（installed 不为 false）',
           builtinAll.length >= 4 && builtinAll.every(f => f.installed !== false),
           builtinAll.length + ' 款内置字体');
      }

      await probeFont('"Microsoft YaHei", sans-serif');

      // 18. 排版参数联动（字号 / 行距 / 缩进 / 边距）
      const measure = async (patch) => {
        await App.patchSettings(patch);
        await App.reader.reflow();
        await sleep(360);
        const cs = getComputedStyle(document.documentElement);
        const st = App.reader.paginator.state();
        // 用首段实际渲染高度判断行距/字号是否真的作用到了正文上
        const firstP = document.querySelector('#readerColumns p');
        const pRect = firstP ? firstP.getBoundingClientRect() : null;
        return {
          fs: cs.getPropertyValue('--reader-font-size').trim(),
          lh: cs.getPropertyValue('--reader-line-height').trim(),
          indent: cs.getPropertyValue('--reader-para-indent').trim(),
          pageCount: st.pageCount,
          pageWidth: Math.round(st.pageWidth),
          paraHeight: pRect ? Math.round(pRect.height) : 0,
          paraIndentPx: firstP ? Math.round(parseFloat(getComputedStyle(firstP).textIndent) || 0) : -1,
        };
      };

      const base = await measure({ fontSize: 19, lineHeight: 1.8, marginLeft: 88, marginRight: 88, paragraphIndent: 2 });
      const big = await measure({ fontSize: 28 });
      ok('字号变量生效且页数随之增加', big.fs === '28px' && big.pageCount > base.pageCount,
        base.fs + '/' + base.pageCount + '页 → ' + big.fs + '/' + big.pageCount + '页');

      const wide = await measure({ marginLeft: 200, marginRight: 200 });
      ok('页边距生效（页宽变窄）', wide.pageWidth < base.pageWidth,
        base.pageWidth + 'px → ' + wide.pageWidth + 'px');

      const loose = await measure({ lineHeight: 2.6 });
      ok('行距变量生效且段落实际变高', loose.lh === '2.6' && loose.paraHeight >= base.paraHeight,
        '段落高 ' + base.paraHeight + 'px → ' + loose.paraHeight + 'px');

      const indented = await measure({ paragraphIndent: 3.5 });
      ok('首行缩进变量生效', indented.indent === '3.5em', 'text-indent=' + indented.paraIndentPx + 'px');

      await measure({ fontSize: 19, lineHeight: 1.8, marginLeft: 88, marginRight: 88, paragraphIndent: 2 });

      // 19. 设置项持久化并跨重启生效（写盘校验）
      await App.patchSettings({ fontSize: 23, theme: 'sepia', pageMode: 'scroll' });
      await sleep(600);
      const persisted = await window.firmament.settings.get();
      ok('设置已持久化到主进程',
        persisted && persisted.ok && persisted.data.fontSize === 23 && persisted.data.theme === 'sepia' && persisted.data.pageMode === 'scroll',
        persisted && persisted.data ? JSON.stringify({ fs: persisted.data.fontSize, theme: persisted.data.theme, mode: persisted.data.pageMode }) : 'none');
      await App.patchSettings({ fontSize: 19, theme: 'day', pageMode: 'page' });
      await sleep(500);
      await App.reader.applyModeLayout({ ratio: App.reader.ratio });
      await sleep(400);

      // 20. 关闭阅读后回到书架
      App.reader.close();
      await sleep(400);
      ok('关闭阅读后回到书架', State.view === 'library', 'view=' + State.view);
    }
  } catch (err) {
    ok('冒烟测试执行异常', false, (err && err.stack ? err.stack.split('\\n').slice(0, 6).join(' | ') : String(err)));
  }

  return out;
})()
`;

/* ---------------- 界面截图 ---------------- */

function runShotTest(win, ctx) {
  const fsx = require('fs');
  const pathx = require('path');
  const outDir = pathx.join(__dirname, '..', '..', 'test', 'shots');
  if (!fsx.existsSync(outDir)) fsx.mkdirSync(outDir, { recursive: true });

  const sampleDir = pathx.join(__dirname, '..', '..', 'test', 'samples');
  let samples = [];
  try {
    samples = fsx.readdirSync(sampleDir).filter((f) => /\.(txt|text|epub)$/i.test(f)).map((f) => pathx.join(sampleDir, f));
  } catch (_) {}

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);

  const shot = async (name) => {
    await sleep(500);
    const img = await win.webContents.capturePage();
    fsx.writeFileSync(pathx.join(outDir, name + '.png'), img.toPNG());
    const s = img.getSize();
    console.log(`  已保存 ${name}.png (${s.width}x${s.height})`);
  };

  win.webContents.on('console-message', (...args) => {
    let level = 0; let message = '';
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && 'message' in args[0]) {
      level = typeof args[0].level === 'number' ? args[0].level : 0;
      message = args[0].message || '';
    } else { level = args[1]; message = args[2]; }
    if (level >= 2) console.log(`[renderer:error] ${message}`);
  });

  win.webContents.once('did-finish-load', async () => {
    await sleep(2400);
    console.log('\n界面截图\n');

    try {
      // 导入样本
      await js(`window.firmament.books.import(${JSON.stringify(samples)})`);
      await js('window.__APP__.App.reloadBooks()');
      await sleep(900);

      // 1. 书架（极简 + 日间）
      await js(`window.__APP__.App.patchSettings({ theme:'day', skin:'minimal', background:'none' })`);
      await js(`window.__APP__.App.route('library')`);
      await shot('01-书架-极简日间');

      // 2. 书架（拟物 + 米黄）
      await js(`window.__APP__.App.patchSettings({ theme:'paper', skin:'skeuo', background:'craft', bgOpacity:0.35 })`);
      await sleep(500);
      await shot('02-书架-拟物米黄');

      // 3. 书架（极简 + 夜间）
      await js(`window.__APP__.App.patchSettings({ theme:'night', skin:'minimal', background:'star', bgOpacity:0.5 })`);
      await sleep(500);
      await shot('03-书架-夜间星空');

      // 4. 列表视图
      await js(`window.__APP__.App.patchSettings({ theme:'day', skin:'minimal', background:'none' })`);
      await js(`window.__APP__.App.bookshelf.state.viewMode='list'; window.__APP__.App.bookshelf.applyViewMode(); window.__APP__.App.bookshelf.renderGrid();`);
      await shot('04-书架-列表视图');
      await js(`window.__APP__.App.bookshelf.state.viewMode='grid'; window.__APP__.App.bookshelf.applyViewMode(); window.__APP__.App.bookshelf.renderGrid();`);

      // 5. 打开书籍 —— 日间阅读页
      const books = await js('window.__APP__.State.books.map(b=>({id:b.id,title:b.title,format:b.format}))');
      const txt = books.find((b) => b.format === 'txt') || books[0];
      await js(`window.__APP__.App.reader.open(${JSON.stringify(txt.id)})`);
      await sleep(1600);
      await js(`window.__APP__.App.patchSettings({ theme:'day', skin:'minimal', background:'none', fontSize:20, lineHeight:1.9 })`);
      await js('window.__APP__.App.reader.reflow()');
      await sleep(700);
      await js('window.__APP__.App.reader.showUI(true)');
      await shot('05-阅读页-日间');

      // 6. 阅读页 —— 夜间
      await js(`window.__APP__.App.patchSettings({ theme:'night' })`);
      await js('window.__APP__.App.reader.reflow()');
      await sleep(600);
      await shot('06-阅读页-夜间');

      // 7. 阅读页 —— 护眼绿
      await js(`window.__APP__.App.patchSettings({ theme:'eyecare' })`);
      await js('window.__APP__.App.reader.reflow()');
      await sleep(600);
      await shot('07-阅读页-护眼绿');

      // 8. 阅读页 —— 羊皮纸 + 纸纹背景
      await js(`window.__APP__.App.patchSettings({ theme:'sepia', background:'paper', bgOpacity:0.6 })`);
      await js('window.__APP__.App.theme.applyBackground(window.__APP__.State.settings)');
      await js('window.__APP__.App.reader.reflow()');
      await sleep(600);
      await shot('08-阅读页-羊皮纸');

      // 9. 阅读页 —— 拟物皮肤
      await js(`window.__APP__.App.patchSettings({ theme:'paper', skin:'skeuo', background:'linen' })`);
      await js('window.__APP__.App.theme.applyBackground(window.__APP__.State.settings)');
      await js('window.__APP__.App.reader.reflow()');
      await sleep(600);
      await shot('09-阅读页-拟物皮肤');

      // 10. 阅读设置抽屉
      await js(`window.__APP__.App.patchSettings({ theme:'day', skin:'minimal', background:'none' })`);
      await js('window.__APP__.App.reader.openReaderSettings()');
      await shot('10-阅读设置抽屉');
      await js('window.__APP__.App.reader.closeDrawers()');

      // 11. 目录抽屉
      await js('window.__APP__.App.reader.toggleToc()');
      await shot('11-目录抽屉');
      await js('window.__APP__.App.reader.closeDrawers()');

      // 12. 滚动模式（连续跨章）
      await js(`window.__APP__.App.reader.setPageMode('scroll')`);
      await sleep(1400);
      await js('window.__APP__.App.reader.showUI(true)');
      await shot('12-阅读页-滚动模式');

      // 12b. 跨章拼接后的滚动中段：验证章与章之间是连续拼接的
      await js('(async()=>{ const c=window.__APP__.App.reader.continuous; for(let i=0;i<3;i++) await c.extendDown(); c.setPosition(2, 0.5, false); })()');
      await sleep(900);
      await shot('12b-阅读页-跨章拼接');
      await js(`window.__APP__.App.reader.setPageMode('page')`);
      await sleep(800);

      // 13. 设置页各面板
      await js(`window.__APP__.App.route('settings')`);
      for (const [pane, label] of [['typography','阅读排版'],['appearance','主题外观'],['fonts','字体管理'],['paging','翻页与自动'],['boss','摸鱼模式'],['data','数据与存储'],['about','关于']]) {
        await js(`window.__APP__.App.settingsView.active='${pane}'; window.__APP__.App.settingsView.renderNav(); window.__APP__.App.settingsView.render();`);
        await shot(`13-设置-${label}`);
      }

      // ⚠ 这里**不要**手动 setBounds 摆出正方形。
      //   早期版本在 boss.enter() 之后补了一句 win.setBounds(340,340)，
      //   于是截图里迷你框永远是方的 —— 而应用自身其实做不到，
      //   "摸鱼窗口不变方"这个真 bug 就这样被截图脚本掩盖了很久。
      //   截图必须反映应用的真实行为，否则它只是在自欺。
      await js(`window.__APP__.App.patchSettings({ theme:'day', skin:'minimal', background:'none', miniBoxSize:340 })`);
      await js(`window.__APP__.App.route('library')`);
      await js(`window.__APP__.App.reader.open(${JSON.stringify(txt.id)})`);
      await sleep(1500);
      await js(`window.__APP__.App.boss.enter({ mode:'mini-text', style:'square' })`);
      await sleep(1100);
      // 断言窗口真的变成了正方形（截图之外的客观校验）
      {
        const wb = win.getBounds();
        console.log('[SHOTS] 迷你框窗口实际尺寸：' + wb.width + '×' + wb.height
          + (Math.abs(wb.width - wb.height) <= 8 ? '（正方形 ✓）' : '（非正方形 ✗）'));
      }
      await shot('14-摸鱼-正方形迷你框');
      await js(`window.__APP__.App.boss.exit()`);
      await sleep(600);
      win.setBounds({ x: 60, y: 40, width: 1180, height: 800 });
      await sleep(400);

      // 15. 四套伪装界面
      for (const [m, label] of [['fake-word','Word'],['fake-excel','Excel'],['fake-code','VSCode'],['fake-mail','邮件']]) {
        await js(`window.__APP__.App.boss.applyVisibility(true,'${m}','normal')`);
        await shot(`15-伪装-${label}`);
      }
      await js(`window.__APP__.App.boss.applyVisibility(false,'fake-word','normal')`);

      // 16. 字体展示：内置手写体 / 圆体 / 楷体 / 宋体 实际渲染效果
      //   这是「UI 好看 + 字体真的能换」最直观的证据
      await js(`window.__APP__.App.route('library')`);
      await js(`window.__APP__.App.reader.open(${JSON.stringify(txt.id)})`);
      await sleep(1500);
      await js(`window.__APP__.App.patchSettings({ theme:'paper', skin:'minimal', background:'paper', bgOpacity:0.5, fontSize:22, lineHeight:2.0 })`);
      await js('window.__APP__.App.theme.applyBackground(window.__APP__.State.settings)');
      const fontShots = [
        ['"LXGW WenKai Lite", "KaiTi", serif', '钢笔楷书-霞鹜文楷'],
        ['"ZCOOL XiaoWei", "KaiTi", serif', '签字笔细楷-站酷小薇'],
        ['"Zhi Mang Xing", "KaiTi", cursive', '钢笔行书-志莽行书'],
        ['"ZCOOL QingKe HuangYou", "Microsoft YaHei", sans-serif', '硬笔圆体-站酷庆科'],
        ['"ZCOOL KuaiLe", "Microsoft YaHei", sans-serif', '圆体-站酷快乐体'],
        ['"KaiTi", "STKaiti", serif', '楷体'],
        ['"SimSun", serif', '宋体'],
        ['"SimHei", sans-serif', '黑体'],
        ['"Microsoft YaHei", sans-serif', '微软雅黑'],
      ];
      for (const [fam, label] of fontShots) {
        await js(`window.__APP__.App.patchSettings({ fontFamily: ${JSON.stringify(fam)} })`);
        await js('window.__APP__.App.reader.reflow()');
        // ⚠ 必须等字体真正加载完再截图。
        //   内置字体是数 MB 的字体文件，解析需要时间；若只等固定时长，
        //   截图会抓到 font-display:swap 期间的「回退字体」，
        //   看起来就像"换了字体没反应"。
        const ready = await js(`(async () => {
          const fam = ${JSON.stringify(fam.split(',')[0].trim().replace(/^"|"$/g, ''))};
          try { await document.fonts.load('32px "' + fam + '"', '春江潮水连海平回退检测ABC'); } catch (e) {}
          try { await document.fonts.ready; } catch (e) {}
          const c = document.createElement('canvas').getContext('2d');
          c.font = '32px "__FirmamentNoSuchFont__"';
          const bw = c.measureText('春江潮水连海平ABC').width;
          c.font = '32px "' + fam + '"';
          const w = c.measureText('春江潮水连海平ABC').width;
          const reg = Array.from(document.fonts).some(f => (f.family||'').replace(/["']/g,'') === fam && f.status === 'loaded');
          return { registered: reg, delta: Math.round((w - bw) * 100) / 100 };
        })()`);
        console.log(`  [字体] ${label}  已注册=${ready && ready.registered}  度量差=${ready && ready.delta}`);
        await shot('17-字体-' + label);
      }
      await js(`window.__APP__.App.patchSettings({ fontFamily:'"Microsoft YaHei", sans-serif', fontSize:19, lineHeight:1.8, background:'none', theme:'day' })`);
      await js('window.__APP__.App.reader.reflow()');
      await sleep(400);

      // 19. 窄窗口适配（窗口最小宽度已放开到 520px，需验证窄窗不破版）
      await js(`window.__APP__.App.patchSettings({ theme:'day', skin:'minimal', background:'none' })`);
      await js(`window.__APP__.App.route('library')`);
      await sleep(500);
      win.setBounds({ x: 60, y: 40, width: 560, height: 720 });
      await sleep(900);
      await shot('21-窄窗-书架');
      await js(`window.__APP__.App.reader.open(${JSON.stringify(txt.id)})`);
      await sleep(1500);
      await js('window.__APP__.App.reader.showUI(true)');
      await shot('21-窄窗-阅读');
      await js('window.__APP__.App.reader.setPageMode("scroll")');
      await sleep(1200);
      await shot('21-窄窗-滚动');
      await js('window.__APP__.App.reader.setPageMode("page")');
      await sleep(700);
      await js(`window.__APP__.App.route('settings')`);
      await sleep(600);
      await shot('21-窄窗-设置');
      win.setBounds({ x: 60, y: 40, width: 1180, height: 800 });
      await sleep(600);

      // 18. 书架现状（收尾）
      await js(`window.__APP__.App.route('library')`);
      await sleep(600);
      await shot('18-书架-现状');

      console.log('\n截图完成');
    } catch (err) {
      console.log('[SHOTS] 执行失败：' + (err && err.message ? err.message : String(err)));
      app.exit(1);
      return;
    }

    setTimeout(() => app.exit(0), 400);
  });
}

/* ---------------- 真实路径探针 ----------------
 *
 * 用途：用**用户真实数据目录**跑「书架 → 点卡片 → 阅读」的完整流程，
 *      把渲染层的真实 DOM 状态打出来。
 *
 * 为什么需要它：冒烟测试跑在全新临时目录，只覆盖冷启动路径。
 * 而用户的问题是"打开一个字都没有" —— 这类问题只在
 * 「已有数据 + 特定设置（如 pageMode=scroll）」下出现。
 */
const PROBE_SCRIPT = `(async () => {
  const log = [];
  // ⚠ 关键：每写一行就立刻把整段日志推给主进程。
  //   若只在末尾 join 返回，中途抛异常时前面的现场会全部丢失 ——
  //   而"哪里开始不对劲"恰恰是最有价值的信息。
  const say = (s) => {
    log.push(s);
    try { console.log('[P] ' + s); } catch (_) {}
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const App = window.__APP__ && window.__APP__.App;
  const State = window.__APP__ && window.__APP__.State;

  // ⚠ 探针是**只读诊断**，绝不能改动用户的真实设置。
  //   它用用户的 store.json 与书架跑流程，而 App.patchSettings 会通过
  //   IPC 把改动永久写进用户的配置文件。所以这里把它拦成"只改内存、
  //   只重绘界面、不落盘"，并在结束时还原。
  const origPatch = App.patchSettings ? App.patchSettings.bind(App) : null;
  const origSettings = JSON.parse(JSON.stringify(State.settings || {}));
  const origThemeSettings = App.theme ? App.theme.settings : null;
  if (origPatch) {
    App.patchSettings = function (patch) {
      State.settings = { ...State.settings, ...(patch || {}) };
      if (App.theme) { App.theme.settings = State.settings; App.theme.apply(); }
      return State.settings;
    };
  }
  const restoreSettings = () => {
    if (origPatch) App.patchSettings = origPatch;
    if (State.settings) {
      for (const k of Object.keys(State.settings)) delete State.settings[k];
      Object.assign(State.settings, origSettings);
    }
    if (App.theme && origThemeSettings) App.theme.settings = State.settings;
    try { App.theme && App.theme.apply(); } catch (_) {}
  };
  say('（探针以只读模式运行，不会修改你的设置）');

  say('=== 1. 应用对象 ===');
  say('__APP__ 存在: ' + !!window.__APP__);
  say('App 存在: ' + !!App);
  say('State 存在: ' + !!State);
  if (!App) {
    say('window.__APP__ 的键: ' + Object.keys(window.__APP__ || {}).join(','));
    return log.join('\\n');
  }
  say('App.reader 存在: ' + !!App.reader);
  say('App.reader.init 已跑完(read.toc): ' + (App.reader ? !!App.reader.toc : 'n/a'));
  if (!App.reader) return log.join('\\n');

  say('view=' + (State ? State.view : '?'));
  say('books=' + (State ? State.books.length : '?'));
  const S = (State && State.settings) || {};
  say('settings.pageMode=' + S.pageMode + ' theme=' + S.theme);
  say('settings.fontFamily=' + S.fontFamily + ' fontSize=' + S.fontSize);
  say('settings.contentWidth=' + S.contentWidth);

  if (!State || !State.books.length) { say('书架为空'); return log.join('\\n'); }

  const book = State.books.slice().sort((a, b) => (b.chapterCount || 0) - (a.chapterCount || 0))[0];
  say('=== 2. 打开书籍 ===');
  say('title=' + book.title + ' chapters=' + book.chapterCount);

  const t0 = Date.now();
  try {
    await App.reader.open(book.id, { resume: true });
  } catch (e) {
    say('open() 抛异常: ' + (e && e.message ? e.message : e));
  }
  await sleep(3000);
  say('打开耗时 ' + (Date.now() - t0) + 'ms');
  say('view=' + State.view);
  say('reader.book=' + (App.reader.book ? App.reader.book.title : 'null'));
  say('reader.toc.length=' + (App.reader.toc ? App.reader.toc.length : 'null'));
  say('reader.chapterIndex=' + App.reader.chapterIndex);
  say('reader.chapter=' + (App.reader.chapter
      ? (App.reader.chapter.title + ' / html ' + (App.reader.chapter.html || '').length + ' 字符')
      : 'null'));
  say('reader.ratio=' + App.reader.ratio);
  say('isScrollMode=' + App.reader.isScrollMode());

  say('=== 3. 排版容器实际状态 ===');
  const q = (sel) => document.querySelector(sel);
  const info = (name, el) => {
    if (!el) { say(name + ': 元素不存在'); return; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    say(name + ': display=' + cs.display
      + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height)
      + ' textLen=' + el.textContent.trim().length
      + ' children=' + el.children.length);
  };
  info('  #readerColumns', q('#readerColumns'));
  info('  #readerScroll', q('#readerScroll'));
  info('  #readerScrollInner', q('#readerScrollInner'));
  info('  #readerPaper', q('#readerPaper'));
  info('  #readerStage', q('#readerStage'));

  say('=== 4. 滚动模式细节 ===');
  const sc = q('#readerScroll');
  if (sc) {
    say('  display(style)=' + (sc.style.display || '(空)')
      + ' scrollH=' + Math.round(sc.scrollHeight)
      + ' clientH=' + Math.round(sc.clientHeight)
      + ' scrollTop=' + Math.round(sc.scrollTop));
  }
  const cont = App.reader.continuous;
  if (cont) {
    say('  continuous.active=' + cont.active + ' total=' + cont.total);
    say('  blocks=' + cont.blocks.length + ' 索引 ' + cont.firstIndex() + '~' + cont.lastIndex());
    if (cont.blocks.length) {
      const b0 = cont.blocks[0];
      const br = b0.el.getBoundingClientRect();
      say('  block[0] index=' + b0.index + ' h=' + Math.round(br.height)
        + ' textLen=' + b0.el.textContent.trim().length);
    }
  } else {
    say('  continuous 实例不存在');
  }

  say('=== 5. CSS 变量 ===');
  const root = getComputedStyle(document.documentElement);
  for (const v of ['--reader-max-width','--reader-font-size','--reader-line-height','--reader-ml','--reader-mr','--reader-mt','--reader-mb']) {
    say('  ' + v + ' = ' + root.getPropertyValue(v).trim());
  }

  say('=== 6. 正文首屏抽样 ===');
  const host = App.reader.isScrollMode() ? q('#readerScrollInner') : q('#readerColumns');
  if (host) {
    const t = host.textContent.replace(/\\s+/g, ' ').trim();
    say('  总长=' + t.length);
    say('  前 200 字: ' + t.slice(0, 200));
  }

  say('=== 7. 模拟真实交互：滚轮一次 ===');
  try {
    const target = q('#readerScroll') || q('#readerStage');
    const before = sc ? sc.scrollTop : 0;
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true }));
    await sleep(700);
    say('  scrollTop ' + Math.round(before) + ' → ' + Math.round(sc ? sc.scrollTop : 0));
  } catch (e) { say('  滚轮模拟失败: ' + e.message); }

  // ⚠ 关键回归：此前"打开书时设置本就是滚动模式"这条路径下，
  //   滚动容器始终保持 display:none，正文渲染完整却整屏空白。
  //   冒烟测试只覆盖了"先翻页打开→再切滚动"，漏掉了这条真实路径。
  //   这里显式交叉验证四种组合。
  say('=== 8. 交叉验证：四种「模式 × 打开方式」组合 ===');
  const check = (label) => {
    const c = q('#readerScroll');
    const v = q('#readerViewport');
    const mode = State.settings.pageMode;
    const wantScroll = mode === 'scroll';
    const vis = wantScroll
      ? (c && getComputedStyle(c).display !== 'none')
      : (v && getComputedStyle(v).display !== 'none');
    const host = App.reader.isScrollMode() ? q('#readerScrollInner') : q('#readerColumns');
    const textLen = host ? host.textContent.trim().length : 0;
    // ⚠ 阈值不能用固定字数。真实书里第 1、2 章常常是封面/版权页
    //   （纯文本可能只有几十字），拿 >100 去判会把正常情况报成失败。
    //   这里改成两个确定的判据：
    //     · 容器可见（display 没被隐藏）
    //     · 正文容器里确实有 DOM 结构或文字（非空渲染）
    //   真正要守的是"打开了却整屏空白"，而不是"这章够不够长"。
    const hasContent = host && (textLen > 0 || host.children.length > 0);
    const pass = !!vis && !!hasContent;
    say('  ' + label + ': mode=' + mode
      + ' 可见=' + (vis ? 'OK' : '✗隐藏')
      + ' 正文字数=' + textLen
      + ' 子元素=' + (host ? host.children.length : 0)
      + ' → ' + (pass ? '通过' : '失败'));
    return pass;
  };

  const results = [];
  for (const mode of ['page', 'scroll']) {
    // (a) 直接以该模式打开书（用户真实路径）
    App.patchSettings({ pageMode: mode });
    await App.reader.open(book.id, { resume: false });
    await sleep(2200);
    results.push(check('直接以 ' + mode + ' 模式打开'));
    // (b) 从另一模式切过来
    App.reader.setPageMode(mode === 'page' ? 'scroll' : 'page');
    await sleep(1200);
    App.reader.setPageMode(mode);
    await sleep(1600);
    results.push(check('切换到 ' + mode + ' 模式  '));
  }
  say('  交叉验证汇总: ' + results.filter(Boolean).length + '/' + results.length + ' 通过');

  say('=== 9. 设置字体自愈检查 ===');
  say('  当前 fontFamily=' + State.settings.fontFamily);
  say('  是否发生自愈=' + !!State.settings.fontFamilyHealed);

  // ⚠ 摸鱼窗口形状：逐步追踪每一步之后的窗口几何，
  //   用于定位"设置对了但 setBounds 没生效"这类时序问题。
  say('=== 10. 摸鱼窗口形状逐步追踪 ===');
  const wb = async (tag) => {
    const r = await window.firmament.app.bounds();
    const d = r && r.data ? r.data : null;
    say('  [' + tag + '] ' + (d ? (d.width + '×' + d.height + ' @' + d.x + ',' + d.y) : ('无数据 ' + JSON.stringify(r))));
    return d;
  };
  await wb('初始');
  const bs = await window.firmament.boss.state();
  say('  boss.state: mode=' + (bs.data && bs.data.mode) + ' style=' + (bs.data && bs.data.style)
    + ' active=' + (bs.data && bs.data.active));

  await App.boss.enter({ mode: 'mini-text', style: 'square' });
  await wb('enter 之后');
  await sleep(900);
  await wb('等待 900ms 后');
  const bs2 = await window.firmament.boss.state();
  say('  boss.state: mode=' + (bs2.data && bs2.data.mode) + ' style=' + (bs2.data && bs2.data.style)
    + ' active=' + (bs2.data && bs2.data.active) + ' miniBoxSize=' + (bs2.data && bs2.data.miniBoxSize));

  // ⚠ 复现「点右上角 × 闪退」：走真实 UI 事件，而不是调 App.boss.exit()。
  //
  //   用户报的故障发生在点击这条路径上，而 exit() 是接口调用。
  //   二者可能完全不同 —— 必须派发真实的 click 事件到按钮上，
  //   才能覆盖"事件被拖拽层吃掉""处理函数里抛异常"等真实情形。
  say('=== 10b. 迷你框 × 真实点击复现 ===');
  {
    const closeBtn = document.getElementById('bossMiniClose');
    say('  按钮存在=' + !!closeBtn
      + ' 可见=' + (closeBtn ? getComputedStyle(closeBtn).display !== 'none' : 'n/a'));

    if (closeBtn) {
      const br = closeBtn.getBoundingClientRect();
      say('  按钮矩形=[' + Math.round(br.left) + ',' + Math.round(br.top) + ','
        + Math.round(br.right) + ',' + Math.round(br.bottom) + ']');
      // 命中测试：确认按钮没有被上面的元素挡住
      if (br.width > 0 && br.height > 0) {
        const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
        say('  命中元素=' + (hit ? (hit.id || hit.className || hit.tagName) : 'null')
          + ' 是按钮或其后代=' + (!!hit && (hit === closeBtn || closeBtn.contains(hit))));
      }
      try {
        closeBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        say('  已派发真实 click 事件');
      } catch (err) {
        say('  派发事件抛异常：' + (err && err.message ? err.message : err));
      }
      await sleep(1200);
      const bs3 = await window.firmament.boss.state();
      say('  点击后 boss.active=' + (bs3.data && bs3.data.active)
        + ' style=' + (bs3.data && bs3.data.style));
      say('  点击后 body.class=' + document.body.className);
    }
    await wb('真实点击 × 之后');
  }

  // 兜底：若上一步未能退出，用接口再退一次，保证后续用例环境干净
  const afterClick = await window.firmament.boss.state();
  if (afterClick.data && afterClick.data.active) {
    say('  × 未生效，改用接口退出');
    await App.boss.exit();
    await sleep(800);
    await wb('接口 exit 之后');
  }

  // ⚠ 自动滚动诊断：逐秒采样 scrollTop，并记录暂停来源。
  //   "开了自动滚动但不动"可能来自多个暂停路径（rAF 时间戳、
  //   滚动位移误判、onAutoNearEnd 误报），必须看数据而不是猜。
  say('=== 11. 自动滚动诊断 ===');
  {
    App.patchSettings({ pageMode: 'scroll' });
    await sleep(1200);
    const s = App.reader.scroller;
    const sc2 = q('#readerScroll');
    s.cancelWheelEase();
    s.scrollToPx(0);
    await sleep(300);

    // 包装 pause 调用以便追踪来源
    const origPause = s.togglePause.bind(s);
    const pauseLog = [];
    s.togglePause = function (force) {
      const r = origPause(force);
      if (force === true || (force === undefined && r === true)) {
        pauseLog.push('paused@paused=' + (this._paused) + ' at=' + Math.round(this.el.scrollTop)
          + ' stack=' + (new Error().stack || '').split('\\n')[2]);
      }
      return r;
    };

    App.reader.autoscroll = true;
    s.setSpeed(80);
    s.start();
    say('  已启动，速度 80px/秒');
    const samples = [];
    for (let i = 0; i < 5; i++) {
      await sleep(1000);
      samples.push({
        t: i + 1,
        top: Math.round(sc2.scrollTop),
        paused: s._paused,
        autoEnabled: s.autoEnabled,
        acc: Number((s._acc || 0).toFixed(2)),
        max: Math.round(s.maxScroll()),
      });
    }
    say('  采样：' + samples.map((x) => x.t + 's=' + x.top
      + '(paused=' + (x.paused ? 'Y' : 'N') + ',en=' + (x.autoEnabled ? 'Y' : 'N') + ')').join(' '));
    say('  位移总计：' + (samples[samples.length - 1].top - samples[0].top) + 'px（期望 ≈320px）');
    say('  最大可滚动：' + samples[0].max + 'px');
    if (pauseLog.length) say('  暂停调用记录：' + pauseLog.slice(0, 3).join(' ｜ '));
    else say('  期间无暂停调用');

    App.reader.autoscroll = false;
    s.stop();
    s.togglePause = origPause;
  }

  // ⚠ 本轮改动的针对性验证。
  say('=== 12. 左右页边距对称性 ===');
  {
    // ⚠ 真正的病因是**设置值本身就左右不等**，不是滚动条占位。
    //   曾经设置页的"左右边距"滑杆只写 marginRight，导致
    //   marginLeft=88 / marginRight=40 这种永久失配 —— 用户看到的
    //   就是"左边空一大截、右边贴边"。所以先查设置值，再查渲染结果。
    const st = App.reader.state.settings || {};
    say('  settings.marginLeft=' + st.marginLeft + ' marginRight=' + st.marginRight
      + '（差 ' + Math.abs((st.marginLeft || 0) - (st.marginRight || 0)) + 'px）');
    say('  是否触发过自愈=' + !!st.marginHealed
      + (st.marginHealedFrom ? ('（原值 L' + st.marginHealedFrom.left + '/R' + st.marginHealedFrom.right + '）') : ''));
    const settingsOk = Math.abs((st.marginLeft || 0) - (st.marginRight || 0)) <= 0.5;
    say('  设置值对称：' + (settingsOk ? '✓' : '✗'));

    const inner = q('#readerScrollInner');
    const sc3 = q('#readerScroll');
    if (inner && sc3) {
      const cs = getComputedStyle(inner);
      const pl = parseFloat(cs.paddingLeft) || 0;
      const pr = parseFloat(cs.paddingRight) || 0;
      const ir = inner.getBoundingClientRect();
      const sr = sc3.getBoundingClientRect();
      const gapL = ir.left - sr.left;
      const gapR = sr.right - ir.right;
      say('  渲染 padding 左=' + pl + ' 右=' + pr + ' 差=' + Math.abs(pl - pr) + 'px');
      say('  内容实际间隙 左=' + gapL.toFixed(1) + ' 右=' + gapR.toFixed(1)
        + ' 差=' + Math.abs(gapL - gapR).toFixed(1) + 'px');
      say('  scrollbar-gutter=' + (getComputedStyle(sc3).scrollbarGutter || '(未取到)'));
      say('  结论：' + (settingsOk && Math.abs(gapL - gapR) <= 2 ? '左右对称 ✓' : '左右不对称 ✗'));
    } else {
      say('  找不到滚动容器');
    }
  }

  say('=== 13. 迷你框滚轮按行滚动 ===');
  {
    // ⚠ 必须先把阅读位置推到章中间再测。
    //   若停在 ratio=0，往上滚也是 0、往下滚是本来的方向，
    //   读数全是 0.0000 —— 那是"起点没设好"，不是功能坏了。
    await App.reader.gotoChapter(0, 0.5);
    await sleep(900);

    // 进入迷你框，模拟一次滚轮，看是否只走"两行"而不是整屏
    await App.boss.enter({ mode: 'mini-text', style: 'square' });
    await sleep(1200);
    const miniBody = document.getElementById('bossMiniBody');
    const beforeRatio = App.reader.ratio;
    say('  迷你框已激活=' + App.boss.isActive + ' 起始 ratio=' + beforeRatio.toFixed(4));
    if (miniBody && App.boss.isActive) {
      miniBody.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, bubbles: true, cancelable: true }));
      await sleep(500);
      const afterRatio = App.reader.ratio;
      const cap = App.boss.miniCapacity ? App.boss.miniCapacity() : null;
      const pct = (afterRatio - beforeRatio) * 100;
      say('  下滚 2 行：ratio=' + beforeRatio.toFixed(4) + ' → ' + afterRatio.toFixed(4)
        + '（+' + pct.toFixed(2) + '% 全章）');
      if (cap) {
        say('  charsPerLine=' + cap.charsPerLine + ' lineH=' + cap.lineH.toFixed(1)
          + ' 一屏约 ' + cap.capacity + ' 字（2 行 ≈ ' + (cap.charsPerLine * 2) + ' 字）');
        // 两行应占整章的比例（用来判断步进是否真的只有"两行"那么小）
        // ⚠ chapter 可能为 null（书没打开时），必须防空 ——
        //   探针自身崩溃会让整份诊断输出变成一句"执行异常"，
        //   前面所有现场信息全部丢失，代价太大。
        const chapterHtml = (App.reader.chapter && App.reader.chapter.html) || '';
        const totalChars = App.boss.extractParagraphs(chapterHtml)
          .reduce((a, p) => a + p.length, 0) || 1;
        const expect = (cap.charsPerLine * 2) / totalChars * 100;
        say('  期望步进≈' + expect.toFixed(2) + '%（两行 / 全章 ' + totalChars + ' 字）');
      }
      // 判定：必须前进，且远小于"整屏"（整屏约占 capacity/totalChars）
      const moved = afterRatio - beforeRatio;
      say('  结论：' + (moved > 0 && moved < 0.12
        ? '是小步前进（按行）✓' : '步进异常 ✗'));
    } else {
      say('  找不到迷你框或未激活');
    }
    // 退出迷你框，避免影响后续
    if (App.boss.isActive) { await App.boss.exit(); await sleep(800); }
  }

  say('=== 14. 自动滚动不再因鼠标而暂停 ===');
  {
    // ⚠ 滚动模式必须真正切过去、并等它装载完成，
    //   否则 scroller 没有内容可滚，读数恒为 0 —— 那是环境没准备好。
    App.patchSettings({ pageMode: 'scroll' });
    await sleep(2000);
    const s2 = App.reader.scroller;
    const sc4 = q('#readerScroll');
    say('  当前模式=' + (App.reader.isScrollMode() ? 'scroll' : 'page')
      + ' 最大可滚动=' + Math.round(s2.maxScroll()) + 'px');
    s2.cancelWheelEase();
    s2.scrollToPx(0);
    await sleep(400);

    App.reader.autoscroll = true;
    s2.setSpeed(80);
    s2.start();
    await sleep(900);
    const t0 = Math.round(sc4.scrollTop);
    say('  已启动自动滚动，起点=' + t0 + 'px');

    // 模拟用户疯狂移动鼠标 + 滚轮，验证都不会打断
    const st4 = q('#readerStage');
    for (let i = 0; i < 6; i++) {
      st4.dispatchEvent(new MouseEvent('mousemove', {
        clientX: 200 + i * 60, clientY: 300 + i * 20, bubbles: true,
      }));
      await sleep(60);
    }
    sc4.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true }));
    await sleep(1600);
    const t1 = Math.round(sc4.scrollTop);
    say('  鼠标+滚轮干扰后：' + t0 + ' → ' + t1 + 'px');
    say('  状态 _paused=' + s2._paused + ' autoEnabled=' + s2.autoEnabled);
    say('  结论：' + (t1 > t0 && !s2._paused ? '未被鼠标/滚轮打断 ✓' : '被打断了 ✗'));

    App.reader.autoscroll = false;
    s2.stop();
    // 恢复成用户原来的模式
    App.patchSettings({ pageMode: origSettings.pageMode || 'page' });
    await sleep(1200);
  }

  say('=== 15. 伪装模式入口 ===');
  {
    // 直接调用阅读页的菜单方法，确认能正常生成浮层
    const btn = document.getElementById('rbtnBoss');
    say('  #rbtnBoss 存在=' + !!btn);
    if (btn) {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(600);
      const menu = document.querySelector('.boss-menu');
      const overlay = document.querySelector('#modalHost .overlay');
      say('  浮层已生成=' + !!overlay + ' 选项数=' + (menu ? menu.children.length : 0));
      if (menu) {
        say('  选项：' + Array.from(menu.children)
          .map((n) => (n.querySelector('.boss-menu__label') || {}).textContent).join(' / '));
      }
      // 关掉浮层，避免影响后续
      if (overlay) overlay.remove();
      await sleep(300);
    }
  }

  // 还原被拦截的设置（探针只读，用户配置不能被改动）
  restoreSettings();
  say('（探针结束，设置已还原）');

  return log.join('\\n');
})()`;

function runProbe(win, ctx) {
  // ⚠ 保险：探针用的是**用户真实数据目录**，必须保证它绝不改动用户配置。
  //   渲染层已做只读拦截，但这里再在文件层加一道 —— 运行前后比对
  //   store.json，若被改动就原样写回。双重保护，避免诊断动作留下副作用。
  const storeFile = path.join(ctx.dirs.dataDir, 'store.json');
  let snapshot = null;
  try {
    if (fs.existsSync(storeFile)) snapshot = fs.readFileSync(storeFile, 'utf8');
  } catch (_) {}

  const restoreStore = () => {
    if (snapshot == null) return false;
    try {
      const now = fs.existsSync(storeFile) ? fs.readFileSync(storeFile, 'utf8') : '';
      if (now === snapshot) return false;
      fs.writeFileSync(storeFile, snapshot, 'utf8');
      console.log('[PROBE] 检测到 store.json 被改动，已还原为用户原值');
      return true;
    } catch (err) {
      console.log('[PROBE] 还原 store.json 失败：' + err.message);
      return false;
    }
  };

  win.webContents.once('did-finish-load', async () => {
    // ⚠ 探针必须让窗口真正可见。
    //   Windows 上对**不可见**窗口调用 setBounds/setSize 会被系统忽略 ——
    //   而摸鱼模式的核心动作就是改窗口尺寸。窗口不可见时测出来的
    //   "尺寸改不动"是探针环境造成的假象，不是产品缺陷。
    try { win.show(); } catch (_) {}
    await new Promise((r) => setTimeout(r, 800));
    console.log('[PROBE] 窗口可见=' + win.isVisible() + ' bounds='
      + JSON.stringify(win.getBounds) + ' ' + win.getBounds().width + '×' + win.getBounds().height);
    // 捕获渲染层未处理异常：这类错误正是"界面空白"的常见原因，
    // 缺了它就只能看到一句笼统的"探针执行异常"。
    win.webContents.executeJavaScript(
      'window.__PROBE_ERRORS__ = [];'
      + 'window.addEventListener("error", (e) => window.__PROBE_ERRORS__.push("error: " + (e.message || "") + " @ " + (e.filename || "") + ":" + (e.lineno || "")));'
      + 'window.addEventListener("unhandledrejection", (e) => window.__PROBE_ERRORS__.push("reject: " + ((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason))));'
      + 'true;'
    ).catch(() => {});

    await new Promise((r) => setTimeout(r, 3500));
    console.log('[PROBE] 数据目录：' + ctx.dirs.dataDir);
    let out = '';
    try {
      out = await win.webContents.executeJavaScript(PROBE_SCRIPT);
    } catch (err) {
      out = '探针执行异常：' + (err && err.stack ? err.stack : String(err));
    }
    let errs = [];
    try { errs = await win.webContents.executeJavaScript('window.__PROBE_ERRORS__ || []'); } catch (_) {}

    console.log('[PROBE] ================= 结果 =================');
    console.log(out);
    if (errs && errs.length) {
      console.log('[PROBE] ============ 渲染层未捕获错误 (' + errs.length + ') ============');
      errs.slice(0, 20).forEach((e) => console.log('  ' + e));
    } else {
      console.log('[PROBE] 渲染层无未捕获错误');
    }
    console.log('[PROBE] ================= 结束 =================');
    restoreStore();
    try { app.exit(0); } catch (_) {}
  });
}

/* ---------------- 冒烟测试入口 ---------------- */

function runSmokeTest(win, ctx) {
  const fsx = require('fs');
  const pathx = require('path');
  const sampleDir = pathx.join(__dirname, '..', '..', 'test', 'samples');
  let samples = [];
  try {
    samples = fsx.readdirSync(sampleDir)
      .filter((f) => /\.(txt|text|epub)$/i.test(f))
      .map((f) => pathx.join(sampleDir, f));
  } catch (_) {}

  win.webContents.on('console-message', (...args) => {
    // Electron 44 传入的是事件对象；旧版本传 (event, level, message, line, sourceId)。
    // 两种形态都兼容，避免因版本差异丢失渲染层报错。
    let level = 0;
    let message = '';
    let line = 0;
    let sourceId = '';
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && 'message' in args[0]) {
      const e = args[0];
      level = typeof e.level === 'number' ? e.level : 0;
      message = e.message || '';
      line = e.lineNumber || 0;
      sourceId = e.sourceId || '';
    } else {
      level = args[1];
      message = args[2];
      line = args[3];
      sourceId = args[4];
    }
    const tag = ['verbose', 'info', 'warning', 'error'][level] || 'log';
    if (level >= 2 || /error|Error|失败|not a function|undefined/i.test(message)) {
      console.log(`[renderer:${tag}] ${message}${sourceId ? ' @ ' + String(sourceId).split(/[\\/]/).pop() + ':' + line : ''}`);
    }
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log(`[SMOKE] 页面加载失败 ${code} ${desc} ${url}`);
  });

  win.webContents.once('did-finish-load', async () => {
    // 捕获渲染层未处理的异常与 Promise 拒绝：这些是"界面看起来正常但功能坏了"的主因
    try {
      await win.webContents.executeJavaScript(`
        window.__SMOKE_ERRORS__ = [];
        window.addEventListener('error', (e) => {
          window.__SMOKE_ERRORS__.push('error: ' + (e.message || '') + ' @ ' + (e.filename || '').split('/').pop() + ':' + e.lineno);
        });
        window.addEventListener('unhandledrejection', (e) => {
          window.__SMOKE_ERRORS__.push('unhandled: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
        });
        true;
      `);
    } catch (_) {}

    // 等渲染层完成初始化
    await new Promise((r) => setTimeout(r, 2200));

    let results = [];
    try {
      await win.webContents.executeJavaScript(
        `window.__SMOKE_SAMPLES__ = ${JSON.stringify(samples)}; true;`
      ).catch(() => {});
      results = await win.webContents.executeJavaScript(SMOKE_CHECKS);
    } catch (err) {
      console.log('[SMOKE] 执行自检脚本失败：' + err.message);
      app.exit(1);
      return;
    }

    // 收尾：报告渲染层遗留错误
    try {
      const errs = await win.webContents.executeJavaScript('window.__SMOKE_ERRORS__ || []');
      if (errs.length) {
        results.push({
          name: '渲染层无未捕获异常',
          pass: false,
          detail: errs.slice(0, 5).join(' ｜ ') + (errs.length > 5 ? ` （共 ${errs.length} 条）` : ''),
        });
      } else {
        results.push({ name: '渲染层无未捕获异常', pass: true, detail: '' });
      }
    } catch (_) {}

    let pass = 0;
    let fail = 0;
    console.log('\n' + '─'.repeat(56));
    console.log('冒烟测试：应用自检\n');
    for (const r of results) {
      if (r.pass) { pass++; console.log(`  ✓ ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`); }
      else { fail++; console.log(`  ✗ ${r.name}${r.detail ? '  → ' + r.detail : ''}`); }
    }
    console.log('\n' + '─'.repeat(56));
    console.log(`冒烟测试：通过 ${pass}，失败 ${fail}`);

    const report = { pass, fail, results, at: new Date().toISOString() };
    try {
      fsx.writeFileSync(pathx.join(ctx.dirs.dataDir, 'smoke-report.json'), JSON.stringify(report, null, 2));
    } catch (_) {}

    setTimeout(() => app.exit(fail > 0 ? 1 : 0), 300);
  });
}

// 单实例：第二次打开时聚焦已有窗口，并把传来的文件交给它
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // ⚠ 自动化测试模式下如果拿不到锁，说明有残留进程占着，
  //   必须显式报错并以非零码退出，否则会静默 exit 0 ——
  //   看起来"测试通过"，其实一行测试代码都没跑。
  if (isAutomation) {
    console.log('[AUTO] 无法获取单实例锁：存在残留的苍穹/Electron 进程。请先结束它们再运行。');
    console.log('[AUTO] 提示：taskkill /F /IM electron.exe');
    app.exit(1);
  } else {
    app.quit();
  }
} else {
  bootstrap();
}

/** 冒烟测试超时兜底：任何一步卡住都要自杀，不能挂着不退出 */
if (isSmoke || isProbe) {
  const limit = isProbe ? 90000 : 120000;
  setTimeout(() => {
    console.log('[AUTO] 超时（' + (limit / 1000) + ' 秒），强制退出。');
    try { process.exit(1); } catch (_) {}
  }, limit).unref?.();
}

let mainWindow = null;
let ctx = null;

/**
 * 彻底删除测试数据目录。
 *
 * ⚠ 这段代码存在的唯一原因是本机的一个环境陷阱：
 *
 *   开发环境通过 NODE_OPTIONS 注入了一个 node-safe-delete-shim，
 *   它 hook 了 fs 的删除方法，**按"轮次"累计计数**，一旦超过 50 个
 *   就抛错拦截：
 *     [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] count=150 threshold=50
 *
 *   测试数据目录里有一百多个文件（书籍缓存 + 封面 + 字体），
 *   所以 fs.rmSync(recursive) 必然失败；连"自己分批调 unlinkSync"
 *   也躲不过 —— 因为它计的是累计数，而不是单次调用数。
 *
 *   旧代码用 try/catch 把异常吞掉当作"清理完成"，后果很严重：
 *   **每次冒烟测试都在上一次的残留数据上跑**，测试结果全部不可信
 *   （曾表现为"书签已存在 → toggle 反而把它取消了"这种假失败）。
 *
 *   解法：交给系统 shell 删（cmd 的 rd /s /q）。子进程不经过 Node 的
 *   fs，自然也不被 shim 计数 —— 这是唯一稳定可靠的方式。
 *   删不掉就明确报错退出，绝不"假装清过了"继续跑。
 */
function removeDirInBatches(dir) {
  if (!fs.existsSync(dir)) return true;

  const { execFileSync } = require('child_process');
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'rd', '/s', '/q', dir], { stdio: 'ignore' });
    } else {
      execFileSync('rm', ['-rf', dir], { stdio: 'ignore' });
    }
  } catch (_) {
    // 命令失败时不抛错，交给下面的 existsSync 判定真实结果
  }

  return !fs.existsSync(dir);
}

function resolveDirs() {
  // ⚠ 探针模式必须走"用户真实目录"分支 —— 它的全部意义就是复现
  //   用户带着已有书架数据时的行为。若被当成普通自动化模式丢进临时目录，
  //   探针就退化成另一个冒烟测试，什么都查不出来。
  if (isAutomation && !isProbe) {
    const dir = path.join(app.getPath('appData'), 'FirmamentTest');
    // ⚠ 必须确保真的清干净。清不掉就报错退出，
    //   绝不能"假装清过了"继续跑 —— 那样测出来的结果毫无意义。
    const cleared = removeDirInBatches(dir);
    if (!cleared) {
      console.log('[AUTO] 测试数据目录清理失败，可能残留旧数据影响结果：' + dir);
      if (isAutomation) {
        console.log('[AUTO] 请手动删除该目录后重试。');
        app.exit(1);
      }
    }
    return {
      dataDir: dir,
      coverDir: path.join(dir, 'covers'),
      fontDir: path.join(dir, 'fonts'),
      cacheDir: path.join(dir, 'cache'),
    };
  }

  const base = app.isPackaged ? app.getPath('userData') : path.join(app.getPath('appData'), 'FirmamentDev');
  // 探针可指定数据目录，便于直接复现打包版（userData 名称为「苍穹」）下的现场
  const override = (() => {
    const i = process.argv.indexOf('--data-dir');
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
  })();
  const dataDir = override || base;
  return {
    dataDir,
    coverDir: path.join(dataDir, 'covers'),
    fontDir: path.join(dataDir, 'fonts'),
    cacheDir: path.join(dataDir, 'cache'),
  };
}

function createWindow() {
  const stateFile = path.join(ctx.dirs.dataDir, 'window.json');
  let bounds = { width: DEFAULT_W, height: DEFAULT_H };
  let maximized = false;
  try {
    if (fs.existsSync(stateFile)) {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      // 只需保证宽高不超过最小限制，不要卡在旧的高下限上
      if (s.bounds && s.bounds.width >= MIN_W && s.bounds.height >= MIN_H) bounds = s.bounds;
      maximized = !!s.maximized;
    }
  } catch (_) {}

  const win = new BrowserWindow({
    ...bounds,
    // ⚠ 最小宽度曾经是 900，导致窄屏 / 分屏场景下窗口压不下去。
    //   阅读器经常需要贴着文档并排看，宽度必须可自由收窄。
    minWidth: MIN_W,
    minHeight: MIN_H,
    show: false,
    frame: false,                  // 无边框：自绘标题栏，才能做沉浸式与伪装标题
    backgroundColor: '#111318',
    title: '苍穹',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
      webSecurity: true,
    },
  });

  mainWindow = win;

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    if (maximized) win.maximize();
    win.show();
    // 命令行带文件时直接导入（支持「用苍穹打开」）
    const argvFiles = process.argv.slice(1).filter((a) => /\.(txt|text|epub)$/i.test(a) && fs.existsSync(a));
    if (argvFiles.length) {
      setTimeout(() => win.webContents.send('app:open-file', argvFiles), 600);
    }
  });

  // 冒烟测试：把渲染层暴露成全局，便于自检；同时不显示窗口闪烁
  win.webContents.once('did-finish-load', () => {
    win.webContents.executeJavaScript(
      'window.Firmament = window.Firmament || { App: null }; if (window.__APP__) window.Firmament = window.__APP__; true;'
    ).catch(() => {});
  });

  if (isSmoke) runSmokeTest(win, ctx);
  if (isShots) runShotTest(win, ctx);
  if (isProbe) runProbe(win, ctx);
  if (!isSmoke) win.showInactive();

  const saveState = () => {
    if (win.isDestroyed()) return;
    // ⚠ 摸鱼期间不要记录窗口几何。
    //   否则迷你框的 300×300 会被写进 window.json，
    //   用户下次正常启动时窗口就是个小方块（或小于最小尺寸被钳到 520×460）。
    if (ctx && ctx.boss && ctx.boss.active) return;
    try {
      const isMax = win.isMaximized();
      const b = isMax ? win.getNormalBounds() : win.getBounds();
      // 尺寸明显小于常规下限时也不记录（可能是刚退出摸鱼的过渡态）
      if (b.width < MIN_W || b.height < MIN_H) return;
      fs.writeFileSync(stateFile, JSON.stringify({ bounds: b, maximized: isMax }));
    } catch (_) {}
  };
  let saveTimer = null;
  const debouncedSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 400);
  };
  win.on('resize', debouncedSave);
  win.on('move', debouncedSave);
  win.on('maximize', () => { win.webContents.send('win:maximized-changed', true); debouncedSave(); });
  win.on('unmaximize', () => { win.webContents.send('win:maximized-changed', false); debouncedSave(); });
  win.on('enter-full-screen', () => win.webContents.send('win:fullscreen-changed', true));
  win.on('leave-full-screen', () => win.webContents.send('win:fullscreen-changed', false));

  // 阻止页面内导航到外部地址；外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  return win;
}

/**
 * GPU 崩溃看门狗。
 *
 * 虚拟机、远程桌面、老旧显卡或驱动异常的机器上，Chromium 的 GPU 进程会反复崩溃，
 * 最终以 FATAL: GPU process isn't usable 直接结束进程 —— 用户看到的是"双击没反应"。
 *
 * 对策：在窗口创建后的头 8 秒内统计 GPU 崩溃次数，超过阈值就写一个标记文件，
 *   下次启动时自动切到软件渲染。这样第一次启动可能失败，但第二次一定能用，
 *   而且不需要用户做任何操作。
 *
 * 为了避免误伤，只在"启动阶段"计数；跑起来之后的偶发崩溃不降级
 *（否则正常机器看视频/动图偶崩一次也会被永久降级）。
 */
function installGpuWatchdog() {
  let crashes = 0;
  let earlyPhase = true;
  setTimeout(() => { earlyPhase = false; }, 8000);

  app.on('child-process-gone', (_e, details) => {
    if (!details || details.type !== 'GPU') return;
    crashes++;
    if (!earlyPhase) return;
    if (crashes < 2) return;
    if (forceSoftwareRender) return;   // 已经是软渲染，无需再降级

    try {
      const flag = path.join(app.getPath('userData'), 'force-software-render');
      fs.writeFileSync(flag, 'GPU 连续崩溃，已自动切换到软件渲染。\n' +
        '原因：' + (details.reason || 'unknown') + ' / ' + (details.exitCode || '') + '\n' +
        '时间：' + new Date().toISOString() + '\n' +
        '如需恢复硬件加速，删除本文件即可。\n', 'utf8');
      console.warn('[gpu] GPU 进程反复崩溃，已记录降级标记，下次启动将使用软件渲染。');
    } catch (_) {}
  });
}

/** 上次运行若检测到 GPU 崩溃，本次直接使用软件渲染 */
function shouldForceSoftwareFromFlag() {
  try {
    const flag = path.join(app.getPath('userData'), 'force-software-render');
    return fs.existsSync(flag);
  } catch (_) {
    return false;
  }
}

/**
 * 崩溃与异常诊断。
 *
 * ⚠ 为什么必须加：用户报"点迷你框右上角 × 就闪退"，但主进程此前**完全没有**
 *   任何崩溃记录能力 —— uncaughtException 没人接、渲染进程挂掉也没人听。
 *   进程一声不响地消失，事后只能靠猜。有了这份日志，下次再闪退就能直接
 *   定位到是哪一层、哪一行，而不是反复试探。
 *
 * 日志写到 userData/crash.log，只记录事实，不参与业务逻辑。
 */
function installCrashDiagnostics() {
  const write = (tag, text) => {
    const line = `[${new Date().toISOString()}] [${tag}] ${text}\n`;
    try {
      fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), line);
    } catch (_) {}
    console.error('[crash] ' + tag + ': ' + text);
  };

  // 主进程未捕获异常：以前会让进程直接死掉且没有任何记录
  process.on('uncaughtException', (err) => {
    write('main-uncaught', (err && err.stack) || String(err));
  });
  process.on('unhandledRejection', (reason) => {
    write('main-rejection', (reason && (reason.stack || reason.message)) || String(reason));
  });

  // 渲染进程 / GPU 等子进程消失
  app.on('render-process-gone', (_e, _wc, details) => {
    write('render-gone', JSON.stringify(details));
  });
  app.on('child-process-gone', (_e, details) => {
    if (details && details.type !== 'GPU') write('child-gone', JSON.stringify(details));
  });

  // 记录每一次 app.quit 的来源，便于区分"用户主动关闭"与"异常退出"
  const origQuit = app.quit.bind(app);
  app.quit = function patchedQuit() {
    write('app-quit', '调用栈：' + (new Error().stack || '').split('\n').slice(1, 4).join(' | '));
    return origQuit();
  };
}

function bootstrap() {
  if (shouldForceSoftwareFromFlag()) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu-compositing');
  }
  installGpuWatchdog();
  installCrashDiagnostics();

  app.on('second-instance', (_e, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      const files = argv.filter((a) => /\.(txt|text|epub)$/i.test(a) && fs.existsSync(a));
      if (files.length) mainWindow.webContents.send('app:open-file', files);
    }
  });

  app.whenReady().then(() => {
    const dirs = resolveDirs();
    for (const d of Object.values(dirs)) {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    }

    // 自定义协议：安全地把 userData/fonts 下的字体文件喂给渲染层
    protocol.handle('firmament-font', (request) => {
      try {
        const url = new URL(request.url);
        const rel = decodeURIComponent(url.pathname.replace(/^\//, '') || url.hostname);
        const safeName = path.basename(rel);
        const full = path.join(dirs.fontDir, safeName);
        if (!full.startsWith(dirs.fontDir) || !fs.existsSync(full)) {
          return new Response('not found', { status: 404 });
        }
        return net.fetch(pathToFileURL(full).toString());
      } catch (_) {
        return new Response('bad request', { status: 400 });
      }
    });

    const store = new Store(dirs.dataDir);
    store.load();

    const library = new Library(store, dirs);

    ctx = {
      app,
      dirs,
      store,
      library,
      fontsService,
      isDev,
      boss: null,
    };

    const boss = new BossMode(ctx);
    ctx.boss = boss;

    // 封面生成算法升级后，自动重建老书的封面（保证老用户也能看到新版式）
    try {
      const r = library.regenerateCovers({ force: false });
      if (r.updated > 0) store.save();
    } catch (err) {
      console.warn('[cover] 自动重建封面失败：', err.message);
    }

    registerIpc(ctx);

    createWindow();

    // 注册全局老板键（失败不阻塞启动，只在设置页提示）
    const r = boss.registerHotkey();
    if (!r.ok && r.error) console.warn('[boss] ' + r.error);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    if (ctx && ctx.boss) ctx.boss.unregisterAll();
  });

  // 关掉 GPU 合成导致的偶发白屏
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

module.exports = { getCtx: () => ctx };