import { nextFrame, rafThrottle, clamp } from '../lib/dom.js';

/**
 * 分页引擎：CSS 多列 + 测量。
 *
 * 原理：
 *   容器设 column-width = 单页可用宽度，column-gap = 页间距，
 *   整章内容会被浏览器自动排成 N 栏，每栏正好是一页。
 *   「翻页」= 容器 translateX(-(页宽 + 页间距) * 页码)。
 *
 * 三个必须处理的坑（同类软件最常翻车的地方）：
 *   1. 字体异步加载 → 行高变化 → 分页错位。必须在 fonts.ready 后强制重排。
 *   2. 图片异步加载 → 高度变化 → 分页错位。必须在图片 load 后重排。
 *   3. 窗口缩放 → 必须防抖重排，且要尽量保持「当前阅读位置」不跳。
 */

export class Paginator {
  /**
   * @param {object} opts
   *   viewport  —— 可视窗口元素（负责裁剪）
   *   clip      —— 单页裁剪层（左右留出完整页边距，避免露出相邻列）
   *   columns   —— 多列容器元素
   *   paper     —— 纸张容器（用于计算可用宽高）
   */
  constructor(opts) {
    this.viewport = opts.viewport;
    this.clip = opts.clip || null;
    this.columns = opts.columns;
    this.paper = opts.paper;
    this.onChange = opts.onChange || (() => {});
    this.pageIndex = 0;
    this.pageCount = 1;
    this.pageWidth = 0;
    this.pageGap = 48;
    this._lastLayoutKey = '';
    this._bound = false;
    this._reflow = rafThrottle(() => this.reflow());
  }

  /** 读取当前页间距（跟随 CSS 变量，保证与视觉一致） */
  readGap() {
    const cs = getComputedStyle(this.columns);
    const gap = parseFloat(cs.columnGap);
    return Number.isFinite(gap) ? gap : 48;
  }

  /**
   * 读取页边距。
   *
   * ⚠ 必须从 CSS 变量读，不能读 .reader-columns 的 computed padding。
   *   因为 padding 正是由本函数计算后写上去的，首次读取时必然是 0，
   *   结果就是正文顶到窗口边缘、和顶栏重叠。
   *   阅读参数统一由 --reader-mt/mb/ml/mr 下发（见 lib/theme.js）。
   */
  readMargins() {
    const cs = getComputedStyle(this.paper || this.columns);
    const varOf = (name, fallback) => {
      const raw = cs.getPropertyValue(name).trim();
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : fallback;
    };
    return {
      top: varOf('--reader-mt', 64),
      bottom: varOf('--reader-mb', 64),
      left: varOf('--reader-ml', 88),
      right: varOf('--reader-mr', 88),
    };
  }

  /**
   * 重排：计算页数与每页宽度。
   * @param {object} opts { keepRatio: boolean, toPage: number }
   * @returns {{ pageCount:number, pageIndex:number }}
   */
  async reflow(opts) {
    const o = opts || {};
    await nextFrame();

    const paperRect = this.paper.getBoundingClientRect();
    const availW = paperRect.width;
    const availH = paperRect.height;
    if (availW <= 0 || availH <= 0) return this.state();

    this.pageGap = this.readGap();

    const m = this.readMargins();

    // 顶栏/底栏是浮在正文之上的（半透明衬底），正文若直接顶到边缘
    // 会被控件压住。这里在用户设定的边距之上再追加一段安全间距。
    const SAFE_TOP = 52;
    const SAFE_BOTTOM = 44;

    const padTop = m.top + SAFE_TOP;
    const padBottom = m.bottom + SAFE_BOTTOM;

    // 单页宽度 = 纸张宽 - 左右边距
    const pageW = Math.max(120, availW - m.left - m.right);
    const pageH = Math.max(80, availH - padTop - padBottom);

    this.pageWidth = pageW;

    // 裁剪层精确等于「一页的可用区域」。
    // ⚠ 必须用 left/top/width/height 定位，不能用 padding ——
    //   padding 不参与 overflow 裁剪，相邻列会从边距区域露出来。
    if (this.clip && this.paper) {
      const pr = this.paper.getBoundingClientRect();
      const cr = this.clip.parentElement
        ? this.clip.parentElement.getBoundingClientRect()
        : { left: 0, top: 0 };
      this.clip.style.left = (pr.left - cr.left + m.left) + 'px';
      this.clip.style.top = (pr.top - cr.top + padTop) + 'px';
      this.clip.style.width = pageW + 'px';
      this.clip.style.height = pageH + 'px';
    }

    // 列容器尺寸 = 裁剪层的内容盒尺寸。
    // ⚠ 列容器自己不设 padding：它的内容盒宽度就是"单页宽"，
    //   上下边距由裁剪层的 padding 提供，否则 column-width 与
    //   实际可用宽不一致，会导致每页末尾丢字。
    this.columns.style.columnWidth = pageW + 'px';
    this.columns.style.width = '100%';
    this.columns.style.height = pageH + 'px';
    this.columns.style.paddingTop = '0';
    this.columns.style.paddingBottom = '0';
    this.columns.style.paddingLeft = '0';
    this.columns.style.paddingRight = '0';

    // 让布局落定
    await nextFrame();

    const scrollW = this.columns.scrollWidth;
    const total = scrollW > 0 ? Math.ceil((scrollW + this.pageGap) / (pageW + this.pageGap)) : 1;
    this.pageCount = Math.max(1, total);

    if (o.toPage != null) {
      this.pageIndex = clamp(Math.round(o.toPage), 0, this.pageCount - 1);
    } else if (o.keepRatio && this.pageCount > 1) {
      // 重排后按比例保持阅读位置（字号变大页数变多时尤其重要）
      const ratio = this._prevRatio != null ? this._prevRatio : this.pageIndex / Math.max(1, this._prevPageCount || 1);
      this.pageIndex = clamp(Math.round(ratio * (this.pageCount - 1)), 0, this.pageCount - 1);
    }
    this.pageIndex = clamp(this.pageIndex, 0, this.pageCount - 1);

    this._prevPageCount = this.pageCount;
    this._prevRatio = this.pageCount > 1 ? this.pageIndex / (this.pageCount - 1) : 0;

    this.applyTransform(true);
    return this.state();
  }

  /** 应用位移 */
  applyTransform(instant) {
    const offset = this.pageIndex * (this.pageWidth + this.pageGap);
    if (instant) this.columns.classList.add('is-instant');
    this.columns.style.transform = `translate3d(${-offset}px, 0, 0)`;
    if (instant) {
      // 强制读一次布局，确保无过渡地落位
      void this.columns.offsetHeight;
      requestAnimationFrame(() => this.columns.classList.remove('is-instant'));
    }
  }

  state() {
    return {
      pageIndex: this.pageIndex,
      pageCount: this.pageCount,
      pageWidth: this.pageWidth,
      pageGap: this.pageGap,
    };
  }

  gotoPage(index, instant) {
    const next = clamp(Math.round(index), 0, this.pageCount - 1);
    const changed = next !== this.pageIndex;
    this.pageIndex = next;
    this.applyTransform(instant !== false);
    if (changed) this.onChange(this.state());
    return this.state();
  }

  next() {
    if (this.pageIndex >= this.pageCount - 1) return { atEnd: true, ...this.state() };
    this.pageIndex += 1;
    this.applyTransform(false);
    this.onChange(this.state());
    return this.state();
  }

  prev() {
    if (this.pageIndex <= 0) return { atStart: true, ...this.state() };
    this.pageIndex -= 1;
    this.applyTransform(false);
    this.onChange(this.state());
    return this.state();
  }

  /** 百分比进度（当前页 / 总页数） */
  ratio() {
    return this.pageCount <= 1 ? 0 : this.pageIndex / (this.pageCount - 1);
  }

  /** 设置阅读比例位置 */
  setRatio(r) {
    const target = Math.round(clamp(r, 0, 1) * (this.pageCount - 1));
    return this.gotoPage(target, true);
  }

  /**
   * 等待所有图片加载完再重排。
   * 图片高度变化会直接打乱分页，这是分页错位的第二大原因。
   */
  async waitImages() {
    const imgs = Array.from(this.columns.querySelectorAll('img'));
    if (!imgs.length) return;
    const pending = imgs.filter((img) => !img.complete);
    if (!pending.length) return;
    await Promise.all(pending.map((img) => new Promise((resolve) => {
      const done = () => {
        img.removeEventListener('load', done);
        img.removeEventListener('error', done);
        resolve();
      };
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
      // 兜底超时，避免个别图片永不触发事件导致卡住
      setTimeout(done, 3000);
    })));
  }

  /** 字体就绪后重排（分页错位的头号原因） */
  async waitFonts() {
    try {
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
    } catch (_) {}
  }

  /** 完整重排流程：等字体 → 等图片 → 计算 */
  async fullReflow(opts) {
    await this.waitFonts();
    await this.waitImages();
    return this.reflow(opts);
  }

  destroy() {
    this._bound = false;
  }
}

/**
 * 滚动引擎：连续流 + 亚像素自动滚动 + 受控滚轮。
 *
 * 关于「连续阅读」：
 *   容器里可以挂多个 .chapter-block（每章一个），由 ReaderView 负责
 *   在接近底部时追加下一章、接近顶部时前插上一章。
 *   本引擎只关心 scrollTop 与内容高度的关系，因此天然支持跨章连续滚动。
 */
export class Scroller {
  constructor(opts) {
    this.el = opts.scroller;               // .reader-scroll
    this.inner = opts.inner;               // .reader-scroll__inner
    this.onProgress = opts.onProgress || (() => {});
    this.onUserScroll = opts.onUserScroll || (() => {});
    this.autoEnabled = false;
    this.speed = 42;                        // px / 秒
    this._raf = null;
    this._lastTs = 0;
    this._acc = 0;                          // 亚像素累加器（关键：避免整数丢失精度）
    this._paused = false;
    /**
     * 最近一次"程序化滚动"的时间戳（Date.now()）。
     * 自动滚动与滚轮缓动都会更新它，scroll 事件据此区分
     * 「程序在滚」和「用户在滚」—— 后者才需要暂停自动滚动。
     *
     * ⚠ 必须与 Date.now() 同源。曾用 rAF 回调的 ts（performance.now()
     *   基准）赋值，与 Date.now() 比较时差值恒为天文数字，导致
     *   "程序化滚动"永远判 false，自动滚动每步都被误判为用户操作
     *   而立即自我暂停。
     *
     * ⚠ 判定**不能只靠时间窗口**。打包版（低帧率）下自动滚动每步间隔
     *   可能超过任何合理的窗口值，于是每一步都被判成"用户滚动"，
     *   自动滚动不断自我暂停、最终彻底停住（实测停在 3106px）。
     *   因此加一个显式状态：自动滚动运行期间，凡是滚动都视为程序化滚动
     *   （真正的用户介入由滚轮/按键/拖动滚动条这些独立事件来判定，
     *    不再靠"位移"猜）。
     */
    this._lastProgrammaticAt = 0;
    this._autoScrolling = false;

    // 滚轮缓动：目标位置 + 自己的 rAF 循环
    this._wheelTarget = null;
    this._wheelRaf = null;
    /** 单次滚轮的最大位移占可视高度的比例（用户反馈原生一次滚太多） */
    this.wheelMaxRatio = 0.22;
    /** 滚轮缓动系数，越大越快跟到目标 */
    this.wheelEase = 0.24;

    this._bind();
  }

  _bind() {
    this._onScroll = () => {
      this.onProgress(this.ratio());
      if (!this.isProgrammaticScroll()) this.onUserScroll();
    };
    this.el.addEventListener('scroll', this._onScroll, { passive: true });
  }

  /** 内容高度可滚动距离 */
  maxScroll() {
    return Math.max(0, this.el.scrollHeight - this.el.clientHeight);
  }

  ratio() {
    const max = this.maxScroll();
    return max <= 0 ? 0 : clamp(this.el.scrollTop / max, 0, 1);
  }

  /** 直接跳到某个像素位置（不走缓动） */
  scrollToPx(px) {
    this.cancelWheelEase();
    this._lastProgrammaticAt = Date.now();
    this.el.scrollTop = clamp(px, 0, this.maxScroll());
  }

  setRatio(r, smooth) {
    const max = this.maxScroll();
    const target = clamp(r, 0, 1) * max;
    this.cancelWheelEase();
    if (smooth) {
      this.el.classList.add('is-smooth');
      this.el.scrollTo({ top: target, behavior: 'smooth' });
      setTimeout(() => {
        this.el.classList.remove('is-smooth');
        this._lastProgrammaticAt = 0;
      }, 420);
    } else {
      this.el.classList.remove('is-smooth');
      this._lastProgrammaticAt = Date.now();
      this.el.scrollTop = target;
    }
  }

  reset() {
    this.cancelWheelEase();
    this.el.scrollTop = 0;
    this._acc = 0;
  }

  /* ——— 受控滚轮 ——— */

  /**
   * 把不同 deltaMode 统一折算成像素位移。
   *   DOM_DELTA_PIXEL = 0（现代浏览器 / 触控板）
   *   DOM_DELTA_LINE  = 1（部分鼠标驱动，单位是"行"）
   *   DOM_DELTA_PAGE  = 2（单位是"页"）
   */
  normalizeWheelDelta(e) {
    const mode = e.deltaMode || 0;
    if (mode === 1) return e.deltaY * 16;                  // 一行按 16px 估
    if (mode === 2) return e.deltaY * this.el.clientHeight; // 一页
    return e.deltaY;
  }

  /**
   * 处理滚轮。返回 true 表示已接管（调用方应 preventDefault）。
   *
   * 为什么要自己接管：Chromium 一次滚轮（notch）默认推进约 3 行，
   * 在中文长段落里会直接跳过一整段，读起来很容易丢行。
   * 这里把单次位移限制在可视高度的 wheelMaxRatio 以内，再用缓动逼近，
   * 手感是"顺滑推进一点点"，而不是"duang 一下跳过去"。
   */
  wheelScroll(e) {
    const raw = this.normalizeWheelDelta(e);
    if (!raw) return false;

    const max = this.maxScroll();
    if (max <= 0) return false;

    const maxStep = Math.max(40, this.el.clientHeight * this.wheelMaxRatio);
    let step = clamp(raw * 0.72, -maxStep, maxStep);

    // 从当前位置（或正在缓动的目标）继续推进
    const base = this._wheelTarget != null ? this._wheelTarget : this.el.scrollTop;
    const target = clamp(base + step, 0, max);
    if (Math.abs(target - base) < 0.5) return false;

    this._wheelTarget = target;
    this.startWheelEase();
    return true;
  }

  startWheelEase() {
    if (this._wheelRaf) return;
    const stepFn = () => {
      this._wheelRaf = null;
      const target = this._wheelTarget;
      if (target == null) return;
      const max = this.maxScroll();
      const clamped = clamp(target, 0, max);
      const cur = this.el.scrollTop;
      const diff = clamped - cur;

      if (Math.abs(diff) < 0.6) {
        this._lastProgrammaticAt = Date.now();
        this.el.scrollTop = clamped;
        this._wheelTarget = null;
        return;
      }

      // ⚠ 不要每步再叠一个 rAF 来复位标志位。
      //   低帧率环境下那些额外回调会显著拖慢缓动
      //   （旧写法实测 420ms 只滚了不到 1px）。
      //   改为记录时间戳，由 isProgrammaticScroll() 按时间判断。
      this._lastProgrammaticAt = Date.now();
      this.el.scrollTop = cur + diff * this.wheelEase;
      this._wheelRaf = requestAnimationFrame(stepFn);
    };
    this._wheelRaf = requestAnimationFrame(stepFn);
  }

  cancelWheelEase() {
    if (this._wheelRaf) cancelAnimationFrame(this._wheelRaf);
    this._wheelRaf = null;
    this._wheelTarget = null;
  }

  /* ——— 自动滚动 ——— */

  setSpeed(pxPerSecond) {
    this.speed = clamp(Number(pxPerSecond) || 42, 4, 400);
  }

  start() {
    if (this.autoEnabled) return;
    this.cancelWheelEase();
    this.autoEnabled = true;
    this._autoScrolling = true;      // 显式状态：此期间的滚动都是程序化的
    this._paused = false;
    this._lastTs = 0;
    this._acc = 0;
    this._tick = (ts) => {
      if (!this.autoEnabled) return;
      if (!this._lastTs) this._lastTs = ts;
      const dt = Math.min(80, ts - this._lastTs); // 夹住 dt，避免切后台回来一次跳很远
      this._lastTs = ts;

      if (!this._paused) {
        const max = this.maxScroll();
        if (this.el.scrollTop >= max - 0.5) {
          // 到底了：先问上层还能不能接上下一章。
          // 连续阅读模式下这里会追加新章节，内容变高就继续滚，
          // 而不是像以前那样直接停下 —— 那是"自动滚动不好用"的主因。
          const extended = !!(this.onAutoNearEnd && this.onAutoNearEnd());
          if (!extended) {
            this.autoEnabled = false;
            this._autoScrolling = false;
            this.onProgress(1);
            this.onAutoEnd && this.onAutoEnd();
            return;
          }
          this._acc = 0;
        } else {
          // 亚像素累加：scrollTop++ 会因取整丢精度并产生卡顿
          this._acc += (this.speed * dt) / 1000;
          if (this._acc >= 0.5) {
            const delta = Math.floor(this._acc * 2) / 2; // 半像素步进
            this._acc -= delta;
            // ⚠ 不要在这里再排一个 requestAnimationFrame。
            //   旧写法每推进一次子像素就额外排一帧，而那些回调又很慢
            //   （无 GPU 的软件渲染环境下尤其明显），会把主循环拖成
            //   正常速度的几分之一 —— 表现为"开了自动滚动但几乎不动"。
            //
            // ⚠ 时间戳必须用 Date.now()，不能用 rAF 回调的 ts。
            //   rAF 传入的是 performance.now() 基准（页面加载起算，约几万），
            //   而 isProgrammaticScroll() 用 Date.now()（纪元起算，约 1.7e12）
            //   比较 —— 两者不同源，差值恒为天文数字，会导致
            //   "程序化滚动"永远判为 false，自动滚动每一步都被当成用户操作
            //   而立即自我暂停（实测：滚到 86px 就再也不动）。
            this._lastProgrammaticAt = Date.now();
            this.el.scrollTop = Math.min(max, this.el.scrollTop + delta);
          }
        }
      }
      this._raf = requestAnimationFrame(this._tick);
    };
    this._raf = requestAnimationFrame(this._tick);
  }

  /**
   * 该次 scroll 事件是否由程序（自动滚动 / 缓动 / 定位）触发。
   *
   * ⚠ 判定顺序很重要：先看显式状态，再看时间窗口。
   *   只靠时间窗口在低帧率环境（打包版实测）会失效 ——
   *   自动滚动每步间隔可能超过窗口值，于是每一步都被误判成
   *   "用户滚动"，触发 pause，自动滚动最终彻底停住。
   */
  isProgrammaticScroll() {
    // 自动滚动运行期间，滚动必然来自程序自身
    if (this._autoScrolling) return true;
    // 滚轮缓动进行中
    if (this._wheelRaf) return true;
    // 定位/跳转刚发生
    const t = this._lastProgrammaticAt;
    if (!t) return false;
    return Math.abs(Date.now() - t) < 120;
  }

  stop() {
    this.autoEnabled = false;
    this._autoScrolling = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  togglePause(force) {
    this._paused = typeof force === 'boolean' ? force : !this._paused;
    if (!this._paused) this._lastTs = 0;
    return this._paused;
  }

  get paused() { return this._paused; }

  destroy() {
    this.stop();
    this.cancelWheelEase();
    this.el.removeEventListener('scroll', this._onScroll);
  }
}

/**
 * 自动翻页调度器（分页模式用）。
 * 与「自动滚动」不同：这里是按固定间隔整页翻，翻到章末自动进入下一章。
 */
export class AutoTurner {
  constructor(opts) {
    this.interval = clamp(Number(opts.interval) || 20, 3, 600); // 秒/页
    this.onTurn = opts.onTurn || (() => {});
    this.enabled = false;
    this._timer = null;
  }

  setInterval_(sec) {
    this.interval = clamp(Number(sec) || 20, 3, 600);
    if (this.enabled) { this.stop(); this.start(); }
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;
    this._loop();
  }

  _loop() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      if (!this.enabled) return;
      this.onTurn();
      this._loop();
    }, this.interval * 1000);
  }

  stop() {
    this.enabled = false;
    clearTimeout(this._timer);
    this._timer = null;
  }

  /** 用户交互时重置计时（避免刚翻完就被自动翻走） */
  kick() {
    if (this.enabled) this._loop();
  }

  destroy() { this.stop(); }
}

/**
 * 阅读位置换算工具：
 * 分页模式存「页比例」，滚动模式存「滚动比例」，
 * 换模式时通过比例互相换算，保证体验连续（同类软件常忽略这点，切模式就跑偏）。
 */
export function ratioBetween(pageState, scrollState) {
  return {
    fromPage: pageState ? pageState.pageIndex / Math.max(1, pageState.pageCount - 1) : 0,
    fromScroll: scrollState != null ? scrollState : 0,
  };
}