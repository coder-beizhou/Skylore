import { $, $$, el, clear, on, esc, clamp, nextFrame } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast, call } from '../lib/toast.js';

/**
 * 摸鱼模式（渲染层）。
 *
 * 三种形态：
 *   square —— 正方形迷你框：只有文字、无选项、无程序边框（主推）
 *   normal —— 完整伪装界面（Word / Excel / VS Code / 邮件）
 *   ghost  —— 隐身：窗口近乎透明
 *
 * 切换性能关键：所有伪装界面在初始化时就预生成好 DOM，
 * 切换只改 CSS 可见性，不触发任何网络请求或重排，保证 <150ms 呈现。
 */

const FAKE_MODES = [
  { key: 'fake-word', label: 'Word 文档', desc: '会议纪要为底，正文即小说，最不引人注意' },
  { key: 'fake-excel', label: 'Excel 表格', desc: '数据表 + 备注列，备注列里是小说' },
  { key: 'fake-code', label: 'VS Code', desc: 'notes.md 里写着正文，带 minimap 与终端面板' },
  { key: 'fake-mail', label: 'Outlook 邮件', desc: '三栏邮件客户端，邮件正文即小说' },
  { key: 'mini-text', label: '纯文字迷你框', desc: '只有一个方框的正文，可双角拖拽调大小' },
  { key: 'mini-overlay', label: '透明迷你框', desc: '背景全透明，文字直接浮在桌面上，可拖拽缩放' },
];

/** 伪装界面里承载小说的容器 → 供滚动阅读使用 */
const FAKE_SCROLL = {
  'fake-word': { scroll: 'fakeWordScroll', inner: 'fakeWordNovel' },
  'fake-excel': { scroll: 'fakeExcelScroll', inner: 'fakeExcelText' },
  'fake-code': { scroll: 'fakeCodeScroll', inner: 'fakeCodeText' },
  'fake-mail': { scroll: 'fakeMailScroll', inner: 'fakeMailNovel' },
};

export class BossView {
  constructor({ state, bus, app }) {
    this.state = state;
    this.bus = bus;
    this.app = app;
    this.api = window.firmament;
    this.isActive = false;
    this.style = 'square';
    this.mode = 'fake-word';
    this._built = false;
    /** 伪装界面（Word/Excel/代码/邮件）正在滚动阅读的容器，非激活时为 null */
    this.fakeScrollEl = null;
    /** 伪装界面的位置上报节流 */
    this._fakePosRaf = null;
    /** 缩放中的标记（抑制误触发翻页点击） */
    this._resizing = false;
    /** 本次伪装界面访问是否还「没滚动过」（决定进来时停顶部还是跟随阅读位置） */
    this._fakeFresh = true;
    this._lastFakeMode = null;
    /** 是否正在程序化设置 scrollTop（用于屏蔽由此触发的 scroll 事件） */
    this._suppressFakeScroll = false;
  }

  async init() {
    const st = await call(this.api.boss.state(), { silent: true });
    if (st) {
      this.mode = st.mode || 'fake-word';
      this.style = st.style || 'square';
      this.isActive = !!st.active;
      this.hotkeyOk = st.hotkeyOk !== false;
      this.hotkeyError = st.hotkeyError || '';
    }

    this.buildFakeContent();
    this.bindEvents();
    this.bus.on('route', () => {
      if (this.isActive) this.renderMini();
    });

    // 主题切换时透明浮窗的字色要跟着变（日间黑字 / 夜间白字）
    if (this.app && this.app.theme && this.app.theme.onChange) {
      this.app.theme.onChange(() => {
        if (this.isActive && this.style === 'overlay') {
          this.api.overlay && this.api.overlay.refresh && this.api.overlay.refresh();
        }
      });
    }

    // 主阅读器换章后，伪装界面/迷你框里的内容要跟着换
    this.bus.on('reader:chapter', () => {
      if (!this.isActive) return;
      if (FAKE_SCROLL[this.mode]) this.renderFakeContent(this.mode);
    });
  }

  /* ============================ 预生成伪装内容 ============================ */

  buildFakeContent() {
    if (this._built) return;
    this._built = true;

    // 外壳部分：这些与「读哪一章」无关，只在启动时构建一次。
    // 注意抬头（会议信息 / 邮件头）不在这里 —— 它们由 buildFakeHead
    // 在真正进入某个伪装界面时按需构建，避免开工就白算一遍。
    this.buildExcelSheet();
    this.buildCodeFile();
    this.buildMailBox();
  }

  /**
   * 伪装界面的「抬头」——固定不变的部分。
   *
   * Word 是一份会议纪要的抬头（时间/地点/参会人 + 几段看起来
   * 完全正常的正文开头），邮件是发件人/主题/时间。
   * 真正要读的小说正文由 renderFakeContent 写进正文容器，
   * 两者拼在一起才像一份完整的文档。
   */
  buildFakeHead(mode) {
    if (mode === 'fake-word') this.buildWordDoc();
    else if (mode === 'fake-mail') this.buildMailHead();
  }

  /** 仿 Word：一份看起来像样的会议纪要 */
  buildWordDoc() {
    const host = $('#fakeWordPage');
    if (!host) return;
    if (host.dataset.built === '1') return;
    host.dataset.built = '1';
    const paras = [
      ['会议时间', '2026年9月18日 14:00 - 15:30'],
      ['会议地点', '总部 3 号楼 12 层第二会议室'],
      ['参会人员', '张明、李伟、王芳、陈晓东、刘婷'],
      ['记录人', '刘婷'],
    ];

    const head = paras.map(([k, v]) =>
      `<p class="doc-no">${esc(k)}：<span style="font-weight:400">${esc(v)}</span></p>`
    ).join('');

    // ⚠ 抬头必须**短**。
    //
    //   最初这里铺了一整份会议纪要（四个小节、十几段），结果真实章节正文
    //   被挤到好几屏之外 —— 用户切进 Word 伪装时满屏都是假会议内容，
    //   翻半天才见到自己在读的小说。伪装只是外壳，正文才是主角。
    //   现在只保留会议信息块 + 一小段过渡文字，小说紧随其后。
    host.innerHTML = `
      <h1>第三季度项目推进情况汇报会 会议纪要</h1>
      ${head}
      <p class="doc-no" style="margin-top:20px">一、本季度工作回顾</p>
      <p>本季度各部门围绕年度经营目标稳步推进各项重点工作，核心系统重构已完成，接口平均响应时间由 480ms 下降至 132ms；市场部在华东、华南两个重点区域完成渠道梳理，新增合作方 14 家。本季度营业收入较上季度增长 12.4%，毛利率保持在合理区间。</p>
    `;
  }

  /** 仿 Excel：带行列号与数据的表格 */
  buildExcelSheet() {
    const host = $('#fakeExcelSheet');
    if (!host) return;

    const cols = ['A', 'B', 'C', 'D', 'E', 'F'];
    const headers = ['项目名称', '一季度', '二季度', '三季度', '同比增幅', '负责人'];
    const rows = [
      ['华东区域收入', '2,845,600', '3,102,450', '3,486,120', '12.4%', '张明'],
      ['华南区域收入', '1,932,400', '2,088,300', '2,341,700', '12.1%', '李伟'],
      ['华北区域收入', '2,105,800', '2,240,600', '2,398,450', '7.0%', '王芳'],
      ['西南区域收入', '986,300', '1,102,750', '1,284,530', '16.5%', '陈晓东'],
      ['线上渠道收入', '3,420,900', '3,886,200', '4,512,800', '16.1%', '刘婷'],
      ['产品采购成本', '-1,845,200', '-1,902,600', '-1,978,400', '4.0%', '赵强'],
      ['物流配送成本', '-486,500', '-502,300', '-518,900', '3.3%', '孙丽'],
      ['人力成本', '-2,340,000', '-2,415,000', '-2,486,000', '2.9%', '周涛'],
      ['市场推广费用', '-680,400', '-742,100', '-798,600', '7.6%', '吴敏'],
      ['营业利润', '1,924,500', '2,266,700', '2,758,300', '21.7%', '张明'],
      ['毛利率', '28.6%', '29.4%', '31.2%', '1.8pp', '—'],
      ['净利率', '12.4%', '13.1%', '14.6%', '1.5pp', '—'],
    ];

    const thead = `<thead><tr><th class="row-head"></th>${cols.map((c, i) =>
      `<th>${c}<br><span style="font-weight:400;font-size:10px">${esc(headers[i])}</span></th>`
    ).join('')}</tr></thead>`;

    const tbody = rows.map((r, i) => {
      const num = String(i + 2);
      return `<tr><td class="row-head">${num}</td>${r.map((c, j) =>
        `<td class="${j >= 1 && j <= 4 ? 'cell-num' : ''}">${esc(c)}</td>`
      ).join('')}</tr>`;
    }).join('');

    host.innerHTML = `<table>${thead}<tbody>${tbody}</tbody></table>`;

    const f = $('#fakeExcelFormula');
    if (f) f.textContent = '=SUM(B2:D2)/COUNT(B2:D2)';
  }

  /** 仿 VS Code：带语法高亮的 TypeScript */
  buildCodeFile() {
    const host = $('#fakeCodeArea');
    if (!host) return;

    const lines = [
      '<span class="tk-cm">// 用户服务：查询与权限校验</span>',
      '<span class="tk-kw">import</span> { <span class="tk-typ">PrismaClient</span> } <span class="tk-kw">from</span> <span class="tk-str">"@prisma/client"</span>;',
      '<span class="tk-kw">import</span> { <span class="tk-fn">verifyToken</span> } <span class="tk-kw">from</span> <span class="tk-str">"./auth"</span>;',
      '',
      '<span class="tk-kw">const</span> <span class="tk-var">prisma</span> = <span class="tk-kw">new</span> <span class="tk-typ">PrismaClient</span>();',
      '',
      '<span class="tk-kw">export async function</span> <span class="tk-fn">getUserProfile</span>(<span class="tk-var">token</span>: <span class="tk-typ">string</span>) {',
      '  <span class="tk-kw">const</span> <span class="tk-var">payload</span> = <span class="tk-kw">await</span> <span class="tk-fn">verifyToken</span>(<span class="tk-var">token</span>);',
      '  <span class="tk-kw">if</span> (!<span class="tk-var">payload</span>) {',
      '    <span class="tk-kw">throw new</span> <span class="tk-typ">Error</span>(<span class="tk-str">"unauthorized"</span>);',
      '  }',
      '',
      '  <span class="tk-kw">const</span> <span class="tk-var">user</span> = <span class="tk-kw">await</span> <span class="tk-var">prisma</span>.<span class="tk-var">user</span>.<span class="tk-fn">findUnique</span>({',
      '    <span class="tk-var">where</span>: { <span class="tk-var">id</span>: <span class="tk-var">payload</span>.<span class="tk-var">sub</span> },',
      '    <span class="tk-var">select</span>: {',
      '      <span class="tk-var">id</span>: <span class="tk-kw">true</span>,',
      '      <span class="tk-var">name</span>: <span class="tk-kw">true</span>,',
      '      <span class="tk-var">email</span>: <span class="tk-kw">true</span>,',
      '      <span class="tk-var">department</span>: <span class="tk-kw">true</span>,',
      '      <span class="tk-var">roles</span>: <span class="tk-kw">true</span>,',
      '    },',
      '  });',
      '',
      '  <span class="tk-kw">return</span> <span class="tk-var">user</span>;',
      '}',
      '',
      '<span class="tk-kw">export async function</span> <span class="tk-fn">listOrders</span>(<span class="tk-var">userId</span>: <span class="tk-typ">string</span>, <span class="tk-var">page</span> = <span class="tk-num">1</span>) {',
      '  <span class="tk-kw">const</span> <span class="tk-var">size</span> = <span class="tk-num">20</span>;',
      '  <span class="tk-kw">const</span> <span class="tk-var">where</span> = { <span class="tk-var">userId</span>, <span class="tk-var">deletedAt</span>: <span class="tk-kw">null</span> };',
      '',
      '  <span class="tk-kw">const</span> [<span class="tk-var">items</span>, <span class="tk-var">total</span>] = <span class="tk-kw">await</span> <span class="tk-var">prisma</span>.<span class="tk-fn">$transaction</span>([',
      '    <span class="tk-var">prisma</span>.<span class="tk-var">order</span>.<span class="tk-fn">findMany</span>({',
      '      <span class="tk-var">where</span>,',
      '      <span class="tk-var">orderBy</span>: { <span class="tk-var">createdAt</span>: <span class="tk-str">"desc"</span> },',
      '      <span class="tk-var">skip</span>: (<span class="tk-var">page</span> - <span class="tk-num">1</span>) * <span class="tk-var">size</span>,',
      '      <span class="tk-var">take</span>: <span class="tk-var">size</span>,',
      '    }),',
      '    <span class="tk-var">prisma</span>.<span class="tk-var">order</span>.<span class="tk-fn">count</span>({ <span class="tk-var">where</span> }),',
      '  ]);',
      '',
      '  <span class="tk-kw">return</span> { <span class="tk-var">items</span>, <span class="tk-var">total</span>, <span class="tk-var">page</span>, <span class="tk-var">size</span> };',
      '}',
    ];

    const frag = document.createDocumentFragment();
    lines.forEach((html, i) => {
      const line = el('div.code-line', {}, [
        el('span.code-line__no', { text: String(i + 1) }),
        el('span.code-line__txt', {
          html: html + (i === 41 ? '<span class="cursor"></span>' : ''),
        }),
      ]);
      frag.appendChild(line);
    });
    host.appendChild(frag);
  }

  /** 邮件阅读窗格的抬头（发件人 / 主题 / 时间 + 操作按钮） */
  buildMailHead() {
    const host = $('#fakeMailHead');
    if (!host || host.dataset.built === '1') return;
    host.dataset.built = '1';
    host.innerHTML =
      '<div class="mail-view__subject">关于Q3经营分析报告的数据口径说明</div>'
      + '<div class="mail-view__from">'
      + '<span class="mail-view__avatar">张</span>'
      + '<div class="mail-view__meta"><b>张明</b><span>财务分析岗</span></div>'
      + '<div class="mail-view__time">今天 09:15</div>'
      + '</div>'
      + '<div class="mail-view__actions"><span>↩ 回复</span><span>↪ 转发</span><span>⋯</span></div>';
  }

  /** 仿 Outlook：邮件三栏 */
  buildMailBox() {
    const listHost = $('#fakeMailList');
    // ⚠ 只校验列表容器。阅读窗格已改名为 fakeMailScroll（拆出抬头），
    //   若这里仍按旧 ID fakeMailView 校验，会整段提前 return ——
    //   表现就是「邮件列表空白、正文也不渲染」，而控制台毫无报错。
    if (!listHost) return;

    const mails = [
      { from: '系统通知中心', subj: '【重要】2026年度绩效考核工作启动通知', pre: '各位同事：根据公司年度工作安排，本年度绩效考核工作将于10月8日正式启动…', time: '09:42' },
      { from: '张明', subj: '关于Q3经营分析报告的数据口径说明', pre: '附件中的数据我已经按照财务口径重新核对了一遍，其中线上渠道部分…', time: '09:15' },
      { from: '项目管理办公室', subj: '第三季度项目进度跟踪表（更新至9月18日）', pre: '现将各单位报送的项目进度汇总如下，请各部门对照计划节点自查…', time: '昨天' },
      { from: 'IT服务台', subj: '办公网络设备维护通知', pre: '为保障办公网络稳定运行，信息中心计划于本周六凌晨进行设备巡检…', time: '昨天' },
      { from: '李伟', subj: '华东区域渠道合作协议（最终版）', pre: '协议文本已经过法务审核，主要修改点集中在结算周期与违约责任条款…', time: '周三' },
      { from: '人力资源部', subj: '9月社保公积金缴纳基数调整说明', pre: '根据最新政策要求，自本月起社保缴纳基数上下限进行调整…', time: '周三' },
      { from: '财务部', subj: '9月费用报销截止时间提醒', pre: '本月费用报销单据请于9月25日17:00前提交至共享中心，逾期将顺延…', time: '周二' },
      { from: '王芳', subj: '客户拜访纪要（9月16日）', pre: '本次拜访主要沟通了明年的合作规模与交付节奏，客户对交付周期…', time: '周二' },
    ];

    clear(listHost);
    mails.forEach((m, i) => {
      // 未读用加粗 + 左侧蓝条（与 is-on 的选中态区分开）
      const cls = [i === 1 ? 'is-on' : '', i < 3 ? 'is-unread' : ''].filter(Boolean).join(' ');
      const row = el('div.mail-row', { class: cls }, [
        el('div.mail-row__top', {}, [
          el('div.mail-row__from', { text: m.from }),
          el('div.mail-row__time', { text: m.time }),
        ]),
        el('div.mail-row__subj', { text: m.subj }),
        el('div.mail-row__pre', { text: m.pre }),
      ]);
      listHost.appendChild(row);
    });

    // ⚠ 这里原本写死了一封完整的假邮件正文 —— 现在正文位置让给小说，
    //   邮件头由 buildMailHead 单独构建（在阅读窗格顶部）。
    //   旧代码一并删除，避免「小说与假邮件混在一起」的诡异效果。
  }

  /* ============================ 事件 ============================ */

  bindEvents() {
    this.bindMiniDrag();
    this.bindMiniTouch();
    this.bindMiniResize();
    this.bindFakeExit();
    this.bindKeyboardExit();

    // 主进程推送的状态同步
    this.api.boss.onToggle && this.api.boss.onToggle((st) => this.syncFromMain(st));
  }

  /**
   * 迷你框：自定义拖拽 + 双击退出。
   *
   * ⚠ 这里刻意不用 CSS 的 -webkit-app-region: drag。
   *   那个方案有两个坑：
   *     1. 拖拽区会吞掉鼠标事件，内部的 dblclick 根本不触发 ——
   *        用户"双击顶部"想退出，结果毫无反应；
   *     2. Windows 会把「双击拖拽区」解释为「最大化窗口」，
   *        于是迷你框一下子铺满全屏 —— 正是用户反馈的"竟然全屏了"。
   *
   *   改成自己监听 mousedown/mousemove 并把位移发给主进程移动窗口后，
   *   双击可以被正常识别；再配合主进程 setMaximizable(false)，
   *   双保险确保不会再误最大化。
   */
  bindMiniDrag() {
    const mini = $('#bossMini');
    if (!mini) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;

    const onDown = (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('#bossMiniClose')) return;   // 点关闭按钮不算拖拽
      dragging = true;
      moved = 0;
      startX = lastX = e.screenX;
      startY = lastY = e.screenY;
      document.body.classList.add('is-dragging-mini');
    };

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.screenX - lastX;
      const dy = e.screenY - lastY;
      lastX = e.screenX;
      lastY = e.screenY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 3) {
        // screenX/Y 是屏幕坐标，与窗口位移同源，不需要再换算 DPI
        this.api.app.moveBy(dx, dy);
      }
    };

    const onUp = () => {
      if (!dragging) return;
      const wasDrag = moved > 5;
      dragging = false;
      document.body.classList.remove('is-dragging-mini');
      // 拖拽结束后短时间内忽略点击，避免"拖完手一松"被当成翻页点击
      if (wasDrag) this._suppressMiniClick = Date.now() + 180;
    };

    mini.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    // 双击顶部区域退出（判定区域放宽到整个迷你框的上 40%，
    // 因为 340px 的框里"顶部"对用户来说是个模糊概念）
    mini.addEventListener('dblclick', (e) => {
      if (e.target.closest('#bossMiniClose')) return;
      const rect = mini.getBoundingClientRect();
      const y = e.clientY - rect.top;
      if (y <= rect.height * 0.4) {
        e.preventDefault();
        e.stopPropagation();
        this.exit();
      }
    });
  }

  /**
   * 迷你框双角缩放（左下角 / 右下角）。
   *
   * ⚠ 为什么两个角都要有：
   *   迷你框默认贴在屏幕右上角。只有右下角能缩放时，用户想把框
   *   往"左"长（远离屏幕边缘）就必须先移动窗口再缩放，很别扭；
   *   左下角把手让窗口可以直接向左下生长，右上角锚点不动 ——
   *   贴右侧边缘时这才是自然的操作方向。
   *
   * 实现：监听鼠标位移 → 换算成目标宽高 → 交给主进程改窗口尺寸
   * （主进程负责工作区边界校验，见 main/boss.js#setBoxSize）。
   */
  bindMiniResize() {
    const mini = $('#bossMini');
    if (!mini) return;

    const grips = [
      { node: $('#bossMiniGripBL'), anchor: 'bl' },
      { node: $('#bossMiniGripBR'), anchor: 'br' },
    ];
    const sizeEl = $('#bossMiniSize');

    grips.forEach(({ node, anchor }) => {
      if (!node) return;

      let resizing = false;
      let startX = 0;
      let startY = 0;
      let baseW = 0;
      let baseH = 0;

      node.addEventListener('mousedown', async (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        const r = await call(this.api.boss.getBoxSize('mini'), { silent: true });
        if (!r) return;
        resizing = true;
        this._resizing = true;
        startX = e.screenX;
        startY = e.screenY;
        baseW = r.width;
        baseH = r.height;

        document.body.classList.add('is-resizing-mini');
        if (sizeEl) {
          sizeEl.classList.add('is-on');
          sizeEl.textContent = baseW + ' × ' + baseH;
        }
      });

      document.addEventListener('mousemove', (e) => {
        if (!resizing) return;
        const dx = e.screenX - startX;
        const dy = e.screenY - startY;

        // 左下角：向右拖是变小，dx 取反
        const wDelta = anchor === 'bl' ? -dx : dx;
        const w = Math.round(baseW + wDelta);
        const h = Math.round(baseH + dy);

        if (sizeEl) sizeEl.textContent = w + ' × ' + h;
        call(this.api.boss.setBoxSize(w, h, 'mini', anchor), { silent: true }).then(() => {
          this.renderMini();
        });
      });

      document.addEventListener('mouseup', () => {
        if (!resizing) return;
        resizing = false;
        document.body.classList.remove('is-resizing-mini');
        if (sizeEl) sizeEl.classList.remove('is-on');
        // 缩放刚结束的短时间内抑制翻页点击
        this._suppressMiniClick = Date.now() + 220;
        setTimeout(() => { this._resizing = false; }, 120);
      });
    });
  }

  /** 迷你框内的点击翻页、滚轮、右键退出 */
  bindMiniTouch() {
    const body = $('#bossMiniBody');
    if (!body) return;

    body.addEventListener('click', (e) => {
      if (e.target.closest('#bossMiniClose')) return;
      // 缩放手柄上的点击不算翻页；刚拖完缩放也抑制一下
      if (e.target.closest('.boss-mini__grip')) return;
      if (this._resizing) return;
      if (this._suppressMiniClick && Date.now() < this._suppressMiniClick) return;
      const rect = body.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (x < rect.width * 0.32) this.miniPrev();
      else if (x > rect.width * 0.68) this.miniNext();
    });

    // 滚轮：**按行**滚动，一次向下两行（用户要求）。
    //
    // ⚠ 不能用原来的 miniNext/miniPrev —— 那是"整屏翻一页"，
    //   400px 的小框里一次跳走整屏，读者完全跟不上。
    //   这里改成按行位移：一次滚轮 notch（deltaY≈100）走两行。
    body.addEventListener('wheel', (e) => {
      e.preventDefault();
      const raw = Number(e.deltaY) || 0;
      if (!raw) return;
      // 认准方向即可，忽略驱动的力度差异：一个方向键帽 = 固定两行
      this.miniScrollLines(raw > 0 ? 2 : -2);
    }, { passive: false });

    // 右键退出 —— 桌面软件的通用直觉
    body.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.exit();
    });
  }

  /** 伪装界面双击顶部栏退出 */
  bindFakeExit() {
    $$('.fake').forEach((f) => {
      const chrome = f.querySelector('.fake__chrome, .ribbon, .fake__toolbar');
      if (chrome) {
        chrome.addEventListener('dblclick', (e) => {
          e.preventDefault();
          this.exit();
        });
      }
    });
  }

  /** 键盘兜底 + 退出按钮 */
  bindKeyboardExit() {
    // 显式退出按钮（可发现性最好的一条路）
    const closeBtn = $('#bossMiniClose');
    if (closeBtn) {
      closeBtn.innerHTML = icon('x', 11);
      closeBtn.addEventListener('mousedown', (e) => { e.stopPropagation(); });
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.exit();
      });
    }

    // 键盘：Esc 退出；伪装界面激活时方向键/翻页键/空格同样能翻页
    document.addEventListener('keydown', (e) => {
      if (!this.isActive) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.exit();
        return;
      }

      // 只在伪装界面形态下接管翻页键（迷你框里没有翻页空间语义）
      if (!this.fakeScrollEl) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;

      // ⚠ 必须 stopPropagation：reader.js 也在 document 上监听 keydown
      //   并会执行 nextPage()/prevPage()。伪装激活时若让它继续跑，
      //   主阅读器的翻页会和伪装容器的滚动互相覆盖 ——
      //   表现就是「按了翻页键没反应 / 画面乱跳」。
      //   （reader.js 侧另有 isActive 守卫做双保险。）
      const HANDLED = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp', ' '];
      if (HANDLED.indexOf(e.key) !== -1) e.stopPropagation();

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          this.fakeScrollEl.scrollTop += 90;
          if (this.fakeAtBottom(this.fakeScrollEl)) this.extendFakeChapter(1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          this.fakeScrollEl.scrollTop -= 90;
          if (this.fakeAtTop(this.fakeScrollEl)) this.extendFakeChapter(-1);
          break;
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          e.preventDefault();
          if (e.shiftKey && e.key === ' ') this.fakePage(-1);
          else this.fakePage(1);
          break;
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault();
          this.fakePage(-1);
          break;
        default:
          break;
      }
    }, true);
  }

  /* ============================ 进入 / 退出 ============================ */

  async enter(opts) {
    const o = opts || {};
    const mode = o.mode || this.mode;
    const style = o.style || this.style;

    this.mode = mode;
    this.style = style;

    // ⚠ 窗口形状由**主进程**根据 store.settings.bossStyle/bossMode 决定，
    //   渲染层的 this.mode/this.style 只是本地缓存。若只改本地缓存就调 toggle，
    //   主进程仍按旧设置调整窗口 —— 会出现「界面已切成迷你框、窗口却没变方」
    //   这种表里不一的状态。因此显式传参时必须先把设置同步给主进程。
    if (o.mode !== undefined || o.style !== undefined) {
      await call(this.api.boss.apply({ mode, style }), { silent: true });
    }

    // 先把渲染层的可见性准备好，再让主进程改窗口形态，
    // 这样用户看到的顺序是「内容先就位 → 窗口变成正方形」，不会闪空白
    const effectiveStyle = this.effectiveStyle(mode, style);
    await this.applyVisibility(true, mode, effectiveStyle);

    const st = await call(this.api.boss.toggle(true), { silent: true });
    if (st) this.syncFromMain(st);
    return st;
  }

  async exit() {
    await this.applyVisibility(false, this.mode, this.style);
    const st = await call(this.api.boss.toggle(false), { silent: true });
    if (st) this.syncFromMain(st);
    // 透明浮窗形态下主窗口被隐藏，退出后必须确保它回到可见状态
    await call(this.api.app.show(), { silent: true });
    this.app.reader && this.app.reader.showUI(true);
    toast('已恢复阅读', { duration: 1400 });
  }

  /**
   * 模式 → 窗口形态。
   *
   * 三个方框形态都靠"窗口本身"呈现，其余伪装界面用普通窗口：
   *   mini-text    → square（不透明迷你框）
   *   mini-overlay → overlay（透明浮窗）
   *   其它          → 传入的 style（normal）
   */
  effectiveStyle(mode, style) {
    if (mode === 'mini-text') return 'square';
    if (mode === 'mini-overlay') return 'overlay';
    return style || 'normal';
  }

  /** 依据形态与模式设置可见性 */
  async applyVisibility(on, mode, style) {
    document.body.classList.remove('is-boss-square', 'is-boss-ghost', 'is-boss-normal', 'is-boss-overlay');
    $$('.fake').forEach((f) => f.classList.remove('is-on'));
    $('#bossMini').classList.add('is-hidden');

    if (!on) {
      document.body.removeAttribute('data-fake-active');
      document.body.classList.add('is-boss-off');
      this.fakeScrollEl = null;
      // 清掉「上次进入的形态」记号：下次进入任何伪装界面都从顶部开始，
      // 保证用户每次切进来都能先看到完整的外壳。
      this._lastFakeMode = null;
      return;
    }
    document.body.classList.remove('is-boss-off');

    if (style === 'overlay') {
      // 透明迷你框由独立浮窗承载：主界面整体隐藏，
      // 但保留"内容容器"的渲染（浮窗靠 IPC 拿快照，不读这里的 DOM）
      document.body.classList.add('is-boss-overlay');
      document.body.setAttribute('data-fake-active', 'true');
    } else if (mode === 'mini-text' || style === 'square') {
      document.body.classList.add('is-boss-square');
      $('#bossMini').classList.remove('is-hidden');
      this.renderMini();
      document.body.setAttribute('data-fake-active', 'true');
    } else if (style === 'ghost') {
      document.body.classList.add('is-boss-ghost');
      document.body.setAttribute('data-fake-active', 'true');
    } else {
      document.body.classList.add('is-boss-normal');
      const node = $(`#${cssId(mode)}`);
      if (node) node.classList.add('is-on');
      else {
        document.body.classList.add('is-boss-square');
        $('#bossMini').classList.remove('is-hidden');
        this.renderMini();
      }
      // 把小说正文嵌进伪装界面，并绑定滚动阅读
      if (FAKE_SCROLL[mode]) this.renderFakeContent(mode);
      if (mode === 'fake-code') this.renderMinimap();
      document.body.setAttribute('data-fake-active', 'true');
    }
    await nextFrame();
  }

  /** 与主进程状态对齐 */
  syncFromMain(st) {
    if (!st) return;
    this.isActive = !!st.active;
    if (st.mode) this.mode = st.mode;
    if (st.style) this.style = st.style;
    this.hotkeyOk = st.hotkeyOk !== false;
    this.hotkeyError = st.hotkeyError || '';

    if (this.isActive) {
      this.applyVisibility(true, this.mode, this.effectiveStyle(this.mode, this.style));
    } else {
      this.applyVisibility(false, this.mode, this.style);
    }

    const btn = $('#rbtnBoss');
    if (btn) btn.classList.toggle('is-on', this.isActive);
  }

  /* ============================ 伪装界面正文 ============================ */

  /**
   * 把小说正文渲染进伪装界面。
   *
   * 设计要点：
   *   · 每个伪装界面只用一个**滚动容器**（Word 的纸张、Excel 的备注列、
   *     代码编辑器、邮件阅读窗格），容器本身保留伪装界面原有的外观，
   *     所以看起来完全是在读一份文档/一列备注/一个 md 文件/一封邮件。
   *   · 位置与主阅读器双向同步：渲染时读 reader 的 (章号, 章内比例)，
   *     滚动时把新位置写回 reader 并落盘 —— 退出后无缝接续。
   */
  /**
   * @param {string} [modeArg] 伪装界面 key。
   *
   * ⚠ 必须接受显式 mode 参数，不能只读 this.mode：
   *   applyVisibility(true, mode, style) 的语义是「按传入的 mode 显示界面」，
   *   而 this.mode 可能还停留在上一次的形态（例如刚从迷你框切到 Excel）。
   *   只读 this.mode 会导致「界面切了、正文没切」—— 伪装界面一片空白。
   */
  renderFakeContent(modeArg) {
    const mode = modeArg || this.mode;
    const conf = FAKE_SCROLL[mode];
    if (!conf) return;

    this.buildFakeHead(mode);

    const scrollEl = $('#' + conf.scroll);
    const innerEl = $('#' + conf.inner);
    if (!scrollEl || !innerEl) return;

    const reader = this.app.reader;
    if (!reader || !reader.chapter) {
      innerEl.innerHTML = '<p>还没有打开任何书籍。</p>';
      return;
    }

    // 记录当前滚动容器，供滚轮/位置同步使用
    this.fakeScrollEl = scrollEl;

    const paras = this.extractParagraphs(reader.chapter.html);
    const totalChars = paras.reduce((a, p) => a + p.length, 0) || 1;
    const ratio = Math.max(0, Math.min(1, reader.ratio || 0));

    // 为让「章内比例 → 滚动位置」可逆，这里渲染**整章**，
    // 再按比例定位 scrollTop。伪装界面是宽屏，整章通常也就几屏高，
    // 比按容量切片更自然（也避免了切片导致的段落重排）。
    //
    // ⚠ 定位时要**扣掉抬头高度**：抬头（会议信息 / 邮件头 / 注释头）
    //   也在这个滚动容器里，直接用 innerEl 的高度算比例会让位置整体偏后，
    //   切进来的瞬间就把抬头滚没了 —— 看起来不像一份完整文档。
    innerEl.innerHTML = paras.map((p) => '<p>' + esc(p) + '</p>').join('\n');

    const headEl = scrollEl.querySelector('.fake-page__head, .mail-view__head, .sheet-note__head, .code-area__head');
    const headH = headEl ? headEl.offsetHeight : 0;

    // ⚠ 首次进入某个伪装界面时，**停在顶部**，让完整外壳（邮件头 /
    //   文档标题 / 文件注释）先被看到 —— 这是「像一份完整文件」的关键。
    //   若一进来就按阅读比例跳到中段，邮件头会被滚出视野，
    //   整个窗口就只剩一屏正文，伪装立刻失效。
    //
    // ⚠ 「首次」必须是**一次访问**的属性，不能是单次渲染的属性：
    //   enter() 会让 applyVisibility 跑两次（第二次来自 syncFromMain 状态回推），
    //   若按「本次渲染是不是第一次」判断，第二次渲染就会按阅读比例
    //   跳到中段 —— 邮件头照样被滚没。所以这里用一个在整次访问期间
    //   保持为真的标记 _fakeFresh，直到用户真的滚动过才置为 false。
    if (this._lastFakeMode !== mode) {
      this._lastFakeMode = mode;
      this._fakeFresh = true;
    }

    // 布局落定后再定位
    requestAnimationFrame(() => {
      const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      // 抬头以下才是正文；比例只作用在正文段上，再整体后移 headH
      const bodyMax = Math.max(0, max - headH);
      // ⚠ 设置 scrollTop 会触发 scroll 事件！若不屏蔽，滚动回调会立刻把
      //   _fakeFresh 清掉，并把「程序设的位置」当成用户滚动回写进阅读器，
      //   于是第二次渲染又跳到中段 —— 「进来先看完整外壳」的设计被自己抹掉。
      this._suppressFakeScroll = true;
      scrollEl.scrollTop = this._fakeFresh ? 0 : Math.round(headH + ratio * bodyMax);
      // 等事件派发完再解除屏蔽
      requestAnimationFrame(() => { this._suppressFakeScroll = false; });
      this.renderFakeStatus();
      if (mode === 'fake-code') this.renderMinimap();
    });

    this.bindFakeScroll(scrollEl);
  }

  /** 伪装界面里的滚动 → 换算成章内比例并写回阅读器（跨章自动拼接） */
  bindFakeScroll(scrollEl) {
    if (scrollEl._bossBound) return;
    scrollEl._bossBound = true;

    let tick = null;
    scrollEl.addEventListener('scroll', () => {
      if (!this.isActive) return;
      if (tick) return;
      tick = requestAnimationFrame(() => {
        tick = null;
        if (!this.isActive) return;
        // 程序化定位（渲染时设置 scrollTop）不参与：既不算用户滚动，
        // 也不回写阅读位置 —— 否则会把刚设好的位置立刻改掉。
        if (this._suppressFakeScroll) return;

        // 用户真的滚动过 → 本次访问不再是「首次」，后续重渲染跟随阅读位置
        this._fakeFresh = false;

        const reader = this.app.reader;
        if (!reader || !reader.chapter) return;

        const max = Math.max(1, scrollEl.scrollHeight - scrollEl.clientHeight);
        // 与渲染时对称：扣掉抬头高度，保证「滚到哪 → 存哪」可逆，
        // 否则每次进出伪装界面阅读位置都会往前漂一段。
        const headEl = scrollEl.querySelector('.fake-page__head, .mail-view__head, .sheet-note__head, .code-area__head');
        const headH = headEl ? headEl.offsetHeight : 0;
        const bodyMax = Math.max(1, max - headH);
        const ratio = Math.max(0, Math.min(1, (scrollEl.scrollTop - headH) / bodyMax));
        reader.ratio = ratio;

        // 与阅读引擎同步：分页模式同步页码，滚动模式同步像素位置
        if (this.state.settings.pageMode === 'scroll') reader.scroller.setRatio(ratio, false);
        else reader.paginator.setRatio(ratio);

        reader.updateProgressUI();
        reader.scheduleSave();
        this.renderFakeStatus();
      });
    }, { passive: true });

    // 滚轮：贴边时自动接续下一章 / 上一章（跨章连续阅读）
    scrollEl.addEventListener('wheel', (e) => {
      if (!this.isActive) return;
      const raw = Number(e.deltaY) || 0;
      if (!raw) return;
      if (raw > 0 && this.fakeAtBottom(scrollEl)) this.extendFakeChapter(1);
      else if (raw < 0 && this.fakeAtTop(scrollEl)) this.extendFakeChapter(-1);
    }, { passive: true });

    // ⚠ 伪装界面同样要能「翻页」，不能只有滚轮。
    //   用户的阅读习惯是在页面上点两侧翻页/用键盘，若伪装界面里点了没反应，
    //   就会以为这个形态是「只读的摆设」。
    //
    //   ⚠ 监听必须挂在 .fake **根节点**而不是滚动容器上：
    //     滚动容器只覆盖正文区（Excel 里更是只有右侧备注列），
    //     点窗口其它空白处（Word 的灰色页边、Excel 的数据表区）就没反应 ——
    //     这正是用户反馈「没法正常翻页」的直接原因之一。
    //     挂根节点后按**窗口宽度**的左右各 26% 判定，整窗皆可点。
    //
    //   中间区域不响应，以免误触；伪装外壳上的交互元素与翻页按钮一律排除。
    const root = scrollEl.closest('.fake');
    if (root && !root._fakeClickBound) {
      root._fakeClickBound = true;
      root.addEventListener('click', (e) => {
        if (!this.isActive) return;
        if (e.target.closest('a, button, [data-no-fake-page], .fake__tab, .sheet-tab, .mail-row, .ribbon-tab, .explorer__item, .win-bar, .fake__chrome, .fake__toolbar, .ribbon-tabs, .statusbar, .sheet-tabs, .formula-bar, .panel, .minimap, .mail-side, .mail-list, .activity-bar, .explorer')) return;
        const rect = root.getBoundingClientRect();
        const fx = (e.clientX - rect.left) / Math.max(1, rect.width);
        if (fx < 0.26) this.fakePage(-1);
        else if (fx > 0.74) this.fakePage(1);
      });
    }

    // 右下角的可见翻页控件（可发现性）
    this.ensureFakeNav(root);
  }

  /**
   * 每个伪装界面右下角的一对「上一章 / 下一章」小按钮 + 章节指示。
   *
   * ⚠ 为什么要有：整窗点击与键盘都是"隐藏交互"，第一次用的人根本不知道
   *   伪装界面里能翻页。一对贴合各伪装风格的小按钮把能力暴露出来，
   *   同时不破坏伪装观感（半透明、悬停才完全显现）。
   */
  ensureFakeNav(root) {
    if (!root) return;
    if (root.querySelector('.fake-nav')) return;
    const nav = document.createElement('div');
    nav.className = 'fake-nav';
    nav.setAttribute('data-no-fake-page', '1');
    nav.innerHTML =
      '<button class="fake-nav__btn" data-fake-nav="prev" title="上一章">‹</button>'
      + '<span class="fake-nav__label"></span>'
      + '<button class="fake-nav__btn" data-fake-nav="next" title="下一章">›</button>';
    nav.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fake-nav]');
      if (!b) return;
      e.stopPropagation();
      const dir = b.getAttribute('data-fake-nav') === 'prev' ? -1 : 1;
      this.fakeStepChapter(dir);
    });
    root.appendChild(nav);
  }

  /** 翻页按钮：到边缘才换章，否则翻一屏（与 fakePage 语义一致但显式换章优先） */
  fakeStepChapter(dir) {
    const el = this.fakeScrollEl;
    if (!el) return;
    if (dir > 0 && this.fakeAtBottom(el)) { this.extendFakeChapter(1); return; }
    if (dir < 0 && this.fakeAtTop(el)) { this.extendFakeChapter(-1); return; }
    this.fakePage(dir);
  }

  /** 伪装界面是否已滚到底 / 顶（用于跨章接续的边界判定） */
  fakeAtBottom(scrollEl) {
    const el = scrollEl || this.fakeScrollEl;
    if (!el) return false;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
  }

  fakeAtTop(scrollEl) {
    const el = scrollEl || this.fakeScrollEl;
    if (!el) return false;
    return el.scrollTop <= 1;
  }

  /**
   * 伪装界面翻一屏。
   *
   * 与主阅读器一致地「按视口高度推进 86%」，而不是一次跳一整章 ——
   * 后者在长章节里会直接丢掉大半内容。到边缘时自动接续相邻章。
   */
  fakePage(dir) {
    const el = this.fakeScrollEl;
    if (!el) return;
    const step = el.clientHeight * 0.86;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    const next = Math.max(0, Math.min(max, el.scrollTop + dir * step));

    // 已经在边缘还要继续翻 → 跨章
    if (dir > 0 && this.fakeAtBottom(el) && next >= max - 1) { this.extendFakeChapter(1); return; }
    if (dir < 0 && this.fakeAtTop(el) && next <= 1) { this.extendFakeChapter(-1); return; }

    el.scrollTo({ top: next, behavior: 'smooth' });
  }

  /** 伪装界面滚到章末/章首时切换章节，并自动接续滚动 */
  async extendFakeChapter(dir) {
    const reader = this.app.reader;
    if (!reader || !reader.toc || !reader.toc.length) return;
    const next = reader.chapterIndex + dir;
    if (next < 0 || next >= reader.toc.length) return;

    // 允许并发前先打个标记，避免连续滚轮触发多次切换
    if (this._fakeSwitchLock) return;
    this._fakeSwitchLock = true;
    try {
      await reader.gotoChapter(next, dir > 0 ? 0 : 1);
      // 换章后重新渲染（定位到目标章首/章末）
      this.renderFakeContent(this.mode);
      // 章首时顶到最上；章末时滚到最下
      const conf = FAKE_SCROLL[this.mode];
      const scrollEl = conf ? $('#' + conf.scroll) : null;
      if (scrollEl) {
        requestAnimationFrame(() => {
          const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
          scrollEl.scrollTop = dir > 0 ? 0 : max;
        });
      }
    } finally {
      setTimeout(() => { this._fakeSwitchLock = false; }, 260);
    }
  }

  /**
   * VS Code 的 minimap（右侧缩略图）。
   *
   * ⚠ 这是 VS Code 最具辨识度的特征之一 —— 空着的 minimap 一眼假。
   *   这里按正文行数生成一批等宽短横线，长短随机（模拟代码行的
   *   参差长度），并在中间留一小段高亮表示当前视口位置。
   */
  renderMinimap() {
    const host = $('#fakeCodeMinimap');
    if (!host) return;
    const textEl = $('#fakeCodeText');
    const lines = textEl ? Math.max(20, Math.round(textEl.scrollHeight / 22)) : 60;
    const count = Math.min(140, lines);
    const out = [];
    for (let i = 0; i < count; i++) {
      // 长度在 30%~100% 之间摆动，看起来像长短不一的代码行
      const w = 30 + Math.round(Math.abs(Math.sin(i * 1.7)) * 70);
      const cls = (i > count * 0.35 && i < count * 0.45) ? ' class="is-view"' : '';
      out.push('<i' + cls + ' style="width:' + w + '%"></i>');
    }
    host.innerHTML = out.join('');
  }

  /** 伪装界面的状态栏文字（页码/字数），让"在工作"的假象更完整 */
  renderFakeStatus() {
    const reader = this.app.reader;
    if (!reader || !reader.chapter) return;
    const ch = (reader.chapterIndex || 0) + 1;
    const total = reader.toc ? reader.toc.length : 1;
    const chars = this.extractParagraphs(reader.chapter.html).reduce((a, p) => a + p.length, 0);

    const wordStatus = $('#fakeWordStatus');
    if (wordStatus) {
      // ⚠ 文案修正：这里显示的是**章**序号，不是页序号。
      //   旧文案「第 n 页，共 N 页」把章号当页号，读者会以为整本书只有 N 页。
      wordStatus.textContent = '第 ' + ch + ' / ' + total + ' 章';
    }
    const wordChars = $('#fakeWordChars');
    if (wordChars) wordChars.textContent = chars.toLocaleString('en-US') + ' 个字';

    const excelStatus = $('#fakeExcelStatus');
    if (excelStatus) excelStatus.textContent = '第 ' + ch + ' / ' + total + ' 章 · 共 ' + chars + ' 字';

    // Excel 备注列表头：跟随当前章节（让"备注"看起来真的在记当前内容）
    const excelHead = $('#fakeExcelHead');
    if (excelHead && reader.chapter) {
      excelHead.textContent = '备注说明（正文）· ' + (reader.chapter.title || ('第 ' + ch + ' 章'));
    }

    // 右下角翻页控件的章节指示
    const navLabel = document.querySelector('.fake.is-on .fake-nav__label');
    if (navLabel) navLabel.textContent = ch + ' / ' + total + ' 章';
  }

  /* ============================ 迷你框内容 ============================ */

  /**
   * 从章节 HTML 抽取「按段落切分」的纯文本。
   * 直接剥标签会把相邻段落粘成一句（</p><p> 之间没有任何分隔符），
   * 所以这里先把段落边界显式转成换行，再逐段处理。
   */
  extractParagraphs(html) {
    return String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|blockquote|li|figure|figcaption)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * 计算迷你框一行能放多少字、总共能放几行。
   *
   * ⚠ 尺寸必须从**真实 DOM** 读，不能再用 settings.miniBoxSize：
   *   双角拖拽后窗口可以是任意宽高（比如 420×260），
   *   若仍按正方形推算，拉宽时会算少行数（内容填不满）、
   *   拉高时会算多行数（末行被裁掉）。
   */
  miniCapacity() {
    const host = $('#bossMiniBody');
    const textEl = $('#bossMiniText');

    // 与 .boss-mini__text 的字号保持同步（0.9 倍正文）
    const fontPx = (this.state.settings.fontSize || 19) * 0.9;
    const lineH = fontPx * 1.72;

    let usableW;
    let usableH;
    if (host && host.clientWidth > 0 && host.clientHeight > 0) {
      const cs = getComputedStyle(host);
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      usableW = host.clientWidth - padX;
      usableH = host.clientHeight - padY;
    } else {
      // 兜底（DOM 尚未布局时）：按设置的宽高估算
      const boxW = this.state.settings.miniBoxW || this.state.settings.miniBoxSize || 300;
      const boxH = this.state.settings.miniBoxH || this.state.settings.miniBoxSize || 300;
      usableW = boxW - 40;
      usableH = boxH - 42;
    }
    // 文字缩进会占掉首行两个字，这里不减，让容量略微保守（宁可少填）
    const textW = textEl && textEl.clientWidth > 0 ? textEl.clientWidth : usableW;

    const charsPerLine = Math.max(6, Math.floor(textW / fontPx));
    const lines = Math.max(3, Math.floor(usableH / lineH));
    // lineH 一并返回：滚轮要按"行"步进，必须知道一行多高
    return { charsPerLine, lines, lineH, capacity: charsPerLine * lines };
  }

  /** 渲染正方形迷你框内容：只有文字，无任何选项 */
  renderMini() {
    const host = $('#bossMiniText');
    if (!host) return;
    const reader = this.app.reader;

    if (!reader || !reader.chapter) {
      host.innerHTML = '<p>还没有打开任何书籍。</p><p>先在书架中选择一本，再进入摸鱼模式。</p>';
      return;
    }

    const paras = this.extractParagraphs(reader.chapter.html);
    if (!paras.length) {
      host.innerHTML = '<p>（本章暂无可显示的内容）</p>';
      return;
    }

    const { charsPerLine, capacity } = this.miniCapacity();
    const ratio = clamp(reader.ratio || 0, 0, 1);

    // 定位到当前比例对应的**字符偏移**。
    //
    // ⚠ 关键：不能只按"段落起点"切，否则滚轮按行滚动会失效 ——
    //   小说一段常有 200+ 字，而滚一次只走两行（约 30 字），
    //   段落起点没变 → 渲染结果完全相同 → 画面纹丝不动，
    //   用户会以为"迷你框滚轮坏了"。
    //   所以这里以字符为单位，允许从段落中间开始显示。
    const totalChars = paras.reduce((a, p) => a + p.length, 0);
    const targetChar = Math.floor(totalChars * ratio);
    let acc = 0;
    let startPara = 0;
    let offsetInPara = 0;
    for (let i = 0; i < paras.length; i++) {
      if (acc + paras[i].length > targetChar) {
        startPara = i;
        offsetInPara = targetChar - acc;
        break;
      }
      acc += paras[i].length;
      startPara = i;
      offsetInPara = 0;
    }
    // 到章末时从最后一段开始，避免空白
    if (ratio >= 0.995) { startPara = Math.max(0, paras.length - 1); offsetInPara = 0; }

    // ⚠ 把段内偏移对齐到整行。
    //   中文（CJK）码位一律等宽，每行恰好 charsPerLine 个字，
    //   所以按 charsPerLine 取整后，画面位移就是**精确的整数行**——
    //   滚两行就是视觉上的两行，不会出现半行的抖动。
    if (offsetInPara > 0) {
      offsetInPara = Math.floor(offsetInPara / charsPerLine) * charsPerLine;
    }

    // 从该段起向下填满容量（多取一段作余量，避免末行露白）
    const picked = [];
    let used = 0;
    for (let i = startPara; i < paras.length; i++) {
      const p = paras[i];
      if (used > 0 && used + p.length > capacity * 1.5) break;
      picked.push(p);
      used += p.length;
      if (used >= capacity) break;
    }
    if (!picked.length) picked.push(paras[startPara]);

    // ⚠ 用「负上边距平移」而不是裁掉文字。
    //
    //   若把首段已读的部分 slice 掉，段落会重新换行 ——
    //   视觉上像"重新排版"而不是"滚动"，且首行缩进会错位。
    //   改成整段渲染再向上平移 N 行（N 为按行对齐后的偏移），
    //   换行位置与真实排版完全一致，看起来就是平滑滚动。
    const { lineH } = this.miniCapacity();
    const offsetLines = offsetInPara > 0 ? offsetInPara / charsPerLine : 0;
    const shiftPx = Math.round(offsetLines * lineH);

    host.innerHTML = picked.map((p) => `<p>${esc(p)}</p>`).join('');
    if (shiftPx > 0) host.style.marginTop = '-' + shiftPx + 'px';
    else host.style.marginTop = '';

    // 顶部进度线 + 悬停提示
    const overall = reader.toc && reader.toc.length
      ? ((reader.chapterIndex + ratio) / reader.toc.length) * 100
      : 0;
    $('#bossMiniLine').style.width = clamp(overall, 0, 100) + '%';
    $('#bossMiniHint').textContent = `第 ${reader.chapterIndex + 1} 章 ｜ 点两侧翻页 ｜ Esc 或右上角 × 退出`;
  }

  /**
   * 把新的章内比例写回阅读引擎并刷新迷你框。
   * 抽出来是因为"整屏翻页"和"滚轮按行滚动"走的是同一条写回路径。
   */
  applyMiniRatio(next) {
    const reader = this.app.reader;
    if (!reader || !reader.chapter) return;
    const r = clamp(next, 0, 1);
    reader.ratio = r;

    // 同步真实阅读位置，退出后能接上
    if (this.state.settings.pageMode === 'scroll') reader.scroller.setRatio(r, false);
    else reader.paginator.setRatio(r);

    this.renderMini();
    reader.updateProgressUI();
    reader.scheduleSave();
  }

  /** 迷你框整屏翻页：按容量步进，而不是整章翻 */
  miniStep(dir) {
    const reader = this.app.reader;
    if (!reader || !reader.chapter) return;
    const paras = this.extractParagraphs(reader.chapter.html);
    const totalChars = paras.reduce((a, p) => a + p.length, 0) || 1;
    const { capacity } = this.miniCapacity();
    const step = capacity / totalChars;
    this.applyMiniRatio((reader.ratio || 0) + dir * step);
  }

  /**
   * 迷你框按「行」滚动（滚轮用）。
   *
   * ⚠ 为什么不能沿用整屏翻页：迷你框只有约 300px，
   *   一次滚轮若按容量步进就跳走整屏文字，读者根本接不上；
   *   按行位移才是滚轮该有的手感。
   *
   * 换算方式：一行的高度为 lineH，先用「每行字数」把像素折算成
   * 字符数，再除以全章总字数得到比例步长 —— 这样即使字号/框大小
   * 变了，滚一行也始终约等于视觉上的一行。
   */
  miniScrollLines(lines) {
    const reader = this.app.reader;
    if (!reader || !reader.chapter) return;
    const paras = this.extractParagraphs(reader.chapter.html);
    const totalChars = paras.reduce((a, p) => a + p.length, 0) || 1;
    const { charsPerLine } = this.miniCapacity();

    // lines 行 ≈ lines 行 × 每行字数 个字符
    const chars = Math.abs(lines) * charsPerLine;
    const step = chars / totalChars;
    this.applyMiniRatio((reader.ratio || 0) + (lines > 0 ? step : -step));
  }

  miniNext() { this.miniStep(1); }
  miniPrev() { this.miniStep(-1); }

  /* ============================ 设置页辅助 ============================ */

  static FAKE_MODES = FAKE_MODES;
}

/** 伪装模式 key → DOM 元素 id（HTML 里用的是 camelCase id） */
const FAKE_DOM_ID = {
  'fake-word': 'fakeWord',
  'fake-excel': 'fakeExcel',
  'fake-code': 'fakeCode',
  'fake-mail': 'fakeMail',
};

function cssId(mode) {
  return FAKE_DOM_ID[mode] || String(mode || '').replace(/[^a-zA-Z0-9_-]/g, '');
}