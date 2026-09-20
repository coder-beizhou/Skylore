import { clamp } from '../lib/dom.js';

/**
 * 连续滚动排版器（跨章无缝阅读）。
 *
 * 解决的问题：
 *   传统阅读器的滚动模式只装载"当前这一章"，滚到底就停住，
 *   必须手动点「下一章」才能继续 —— 连续阅读体验被打断。
 *   这里把每一章做成一个独立的 .chapter-block 块，按需在两端拼接，
 *   于是可以像刷网页一样从第 1 章一路滚到最后一章。
 *
 * 三个必须处理的细节：
 *   1. 向上拼接时，内容插在前面会把当前阅读位置整体下推 ——
 *      必须同步补偿 scrollTop，否则画面会「跳」一下。
 *   2. 无限追加会让 DOM 无限增长 —— 必须裁掉离当前位置太远的块，
 *      裁掉上方块时同样要补偿 scrollTop。
 *   3. 进度归属：滚动位置要能反查「当前是第几章、章内比例多少」，
 *      这样才能正确显示进度、保存续读位置。
 */

export class ContinuousScroll {
  /**
   * @param {object} opts
   *   scroller     —— Scroller 实例（负责 scrollTop / 自动滚动）
   *   inner        —— .reader-scroll__inner 容器
   *   fetch        —— async (chapterIndex) => chapterData
   *   renderInner  —— (chapterData) => html 字符串（章节内部内容）
   *   onPosition   —— ({ index, ratio }) => void
   *   total        —— 总章数
   */
  constructor(opts) {
    this.scroller = opts.scroller;
    this.inner = opts.inner;
    this.fetch = opts.fetch;
    this.renderInner = opts.renderInner || (() => '');
    /** 块插入 DOM 后的回调，用于段落增强等后处理 */
    this.onBlockReady = opts.onBlockReady || (() => {});
    this.onPosition = opts.onPosition || (() => {});
    this.total = opts.total || 0;

    /** 有序章节块 [{ index, el, data }] */
    this.blocks = [];

    /** 保留窗口：当前位置上下各留几个块，超出即裁剪 */
    this.keepAbove = 2;
    this.keepBelow = 3;
    /** 距边缘多少视口高度时触发拼接 */
    this.extendThreshold = 1.1;

    /** 章节判定基准线在视口内的位置（0=顶部，1=底部） */
    this.focusRatio = 0.35;
    /** 跳到某章时，给顶部悬浮工具栏预留的空间 */
    this.jumpHeadroom = 72;

    this._extendUpLock = false;
    this._extendDownLock = false;
    this._generation = 0;
    this.active = false;
  }

  get el() { return this.scroller.el; }

  /* ============================ 几何工具 ============================ */

  /** 元素相对滚动内容顶部的距离（不受当前 scrollTop 影响） */
  topOf(node) {
    const r = node.getBoundingClientRect();
    const cr = this.el.getBoundingClientRect();
    return r.top - cr.top + this.el.scrollTop;
  }

  heightOf(node) {
    return node.getBoundingClientRect().height;
  }

  /** 当前滚动位置（内容坐标系） */
  lineTop() {
    return this.el.scrollTop;
  }

  focusLine() {
    return this.el.scrollTop + this.el.clientHeight * this.focusRatio;
  }

  firstIndex() {
    return this.blocks.length ? this.blocks[0].index : -1;
  }

  lastIndex() {
    return this.blocks.length ? this.blocks[this.blocks.length - 1].index : -1;
  }

  has(index) {
    return this.blocks.some((b) => b.index === index);
  }

  blockOf(index) {
    return this.blocks.find((b) => b.index === index) || null;
  }

  /* ============================ 位置读取 ============================ */

  /**
   * 反查当前阅读位置。
   * 章号用「基准线落在哪个块」判定，章内比例用「视口顶部相对块顶部」计算 ——
   * 这样 ratio 与 setPosition 能精确互为逆运算，切模式/重排都不会跑偏。
   */
  current() {
    if (!this.blocks.length) return { index: 0, ratio: 0 };

    const focus = this.focusLine();
    let cur = this.blocks[0];
    for (const b of this.blocks) {
      const top = this.topOf(b.el);
      const h = this.heightOf(b.el);
      if (focus >= top && focus < top + h) { cur = b; break; }
      if (focus >= top + h) cur = b;   // 落在块间隙时归给上一个
    }

    const top = this.topOf(cur.el);
    const h = Math.max(1, this.heightOf(cur.el));
    let ratio = clamp((this.el.scrollTop - top) / h, 0, 1);

    // 滚到最底部时视为最后一章读完
    const atBottom = this.scroller.maxScroll() - this.el.scrollTop < 2;
    if (atBottom && cur.index === this.lastIndex() && cur.index === this.total - 1) {
      ratio = 1;
    }

    return { index: cur.index, ratio };
  }

  currentData() {
    const { index } = this.current();
    const b = this.blockOf(index);
    return b ? b.data : null;
  }

  /** 全书进度（0~1） */
  overallRatio() {
    const { index, ratio } = this.current();
    if (!this.total) return 0;
    return clamp((index + ratio) / this.total, 0, 1);
  }

  /* ============================ 位置写入 ============================ */

  /**
   * 定位到「某章某比例」。
   * @returns {boolean} 目标块是否已装载（未装载时返回 false，调用方应走 mount）
   */
  setPosition(index, ratio, smooth) {
    const b = this.blockOf(index);
    if (!b) return false;

    const top = this.topOf(b.el);
    const h = this.heightOf(b.el);
    const r = clamp(ratio || 0, 0, 1);
    // 跳到章首时往下让出一点，避免标题被悬浮顶栏压住
    const headroom = r <= 0.001 ? this.jumpHeadroom : 0;
    const target = clamp(top + h * r - headroom, 0, this.scroller.maxScroll());

    if (smooth) this.scroller.setRatio(
      this.scroller.maxScroll() > 0 ? target / this.scroller.maxScroll() : 0,
      true
    );
    else this.scroller.scrollToPx(target);

    return true;
  }

  /** 按视口高度做"翻屏"（键盘 PageDown / 滚轮整页） */
  pageStep(dir) {
    const vh = this.el.clientHeight;
    const target = clamp(this.el.scrollTop + dir * vh * 0.86, 0, this.scroller.maxScroll());
    this.scroller.scrollToPx(target);
  }

  /* ============================ 装载 ============================ */

  /** 生成一个章节块 */
  async createBlock(index) {
    const data = await this.fetch(index);
    if (!data) return null;

    const node = document.createElement('section');
    node.className = 'chapter-block';
    node.dataset.index = String(index);
    node.innerHTML = this.renderInner(data);
    try { this.onBlockReady(node, data); } catch (_) {}

    return { index, el: node, data };
  }

  /**
   * 重建整段流：以 (index, ratio) 为中心装载。
   *
   * 装载顺序必须按索引从小到大依次 append，否则 block 顺序会乱。
   */
  async mount(index, ratio) {
    const gen = ++this._generation;
    this.blocks = [];
    this.inner.innerHTML = '';

    const center = clamp(Number(index) || 0, 0, Math.max(0, this.total - 1));
    const from = clamp(center - 1, 0, Math.max(0, this.total - 1));
    const to = clamp(center + this.keepBelow, 0, Math.max(0, this.total - 1));

    for (let i = from; i <= to; i++) {
      const b = await this.createBlock(i);
      if (gen !== this._generation) return;   // 期间又被重建了，放弃本次
      if (!b) continue;
      this.blocks.push(b);
      this.inner.appendChild(b.el);
    }

    this.active = true;
    // 位置要在布局落定后再设，否则量到的高度不准
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (gen !== this._generation) return;

    if (!this.setPosition(center, ratio || 0, false)) {
      // 目标块没装上（极端情况），退化为顶部
      this.scroller.scrollToPx(0);
    }
    this.trim();
    this.emit();
  }

  /**
   * 向下拼接一章。
   * @returns {Promise<boolean>} 是否真的追加了内容
   */
  async extendDown() {
    if (this._extendDownLock) return false;
    const next = this.lastIndex() + 1;
    if (!this.blocks.length || next >= this.total) return false;
    if (this.has(next)) return false;

    this._extendDownLock = true;
    const gen = this._generation;
    try {
      const b = await this.createBlock(next);
      if (!b || gen !== this._generation) return false;
      this.blocks.push(b);
      this.inner.appendChild(b.el);
      // 布局落定，让后续高度测量准确
      await new Promise((r) => requestAnimationFrame(r));
      if (gen !== this._generation) return false;
      return true;
    } finally {
      this._extendDownLock = false;
    }
  }

  /**
   * 向上拼接一章。
   * ⚠ 插入内容会整体下推当前视图，必须补偿 scrollTop，否则画面会跳。
   */
  async extendUp() {
    if (this._extendUpLock) return false;
    const first = this.firstIndex();
    const prev = first - 1;
    if (!this.blocks.length || prev < 0) return false;
    if (this.has(prev)) return false;

    this._extendUpLock = true;
    const gen = this._generation;
    const beforeScroll = this.el.scrollTop;
    try {
      const b = await this.createBlock(prev);
      if (!b || gen !== this._generation) return false;

      this.blocks.unshift(b);
      this.inner.insertBefore(b.el, this.inner.firstChild);

      // 补偿：新增高度加在当前位置之上，scrollTop 要同步增加
      await new Promise((r) => requestAnimationFrame(r));
      if (gen !== this._generation) return false;
      const added = this.heightOf(b.el);
      this.scroller.scrollToPx(beforeScroll + added);
      return true;
    } finally {
      this._extendUpLock = false;
    }
  }

  /** 接近边缘时主动拼接（滚动过程中调用） */
  ensureEdges() {
    if (!this.active) return;
    const vh = this.el.clientHeight || 1;
    const max = this.scroller.maxScroll();
    const top = this.el.scrollTop;

    if (max - top < vh * this.extendThreshold) this.extendDown();
    if (top < vh * (this.extendThreshold - 0.3)) this.extendUp();
  }

  /** 裁掉离当前位置过远的块，并补偿 scrollTop */
  trim() {
    if (this.blocks.length <= this.keepAbove + this.keepBelow + 1) return;
    const cur = this.current().index;
    const removed = [];
    this.blocks = this.blocks.filter((b) => {
      const keep = b.index >= cur - this.keepAbove && b.index <= cur + this.keepBelow;
      if (!keep) removed.push(b);
      return keep;
    });
    if (!removed.length) return;

    // 只补偿"被裁掉且位于当前位置之上"的部分
    let aboveRemovedHeight = 0;
    for (const b of removed) {
      if (b.index < cur) aboveRemovedHeight += this.heightOf(b.el);
      b.el.remove();
    }
    if (aboveRemovedHeight > 0) {
      this.scroller.scrollToPx(Math.max(0, this.el.scrollTop - aboveRemovedHeight));
    }
  }

  /** 重新测量（字号/字体/行距变化后调用），并尽量保持阅读位置 */
  async remeasure() {
    const { index, ratio } = this.current();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    this.setPosition(index, ratio, false);
    // 内容高度变了，可能需要补新章
    this.ensureEdges();
    this.trim();
    this.emit();
  }

  /** 跳到指定章节（未装载则重建） */
  async gotoChapter(index, ratio) {
    const i = clamp(Number(index) || 0, 0, Math.max(0, this.total - 1));
    const r = clamp(ratio || 0, 0, 1);
    if (this.setPosition(i, r, false)) {
      this.trim();
      await this.extendDown();
      await this.extendUp();
      this.emit();
      return true;
    }
    await this.mount(i, r);
    return true;
  }

  emit() {
    const pos = this.current();
    this.onPosition(pos, this.blockOf(pos.index) ? this.blockOf(pos.index).data : null);
  }

  clear() {
    this._generation++;
    this.blocks = [];
    this.inner.innerHTML = '';
    this.active = false;
  }
}