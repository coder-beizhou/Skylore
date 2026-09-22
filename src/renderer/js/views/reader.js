import { $, $$, el, clear, on, esc, fmtNum, debounce, clamp, delegate, rafThrottle, getSelectionText, fmtRelative } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast, call } from '../lib/toast.js';
import { Paginator, Scroller, AutoTurner } from '../engine/paginator.js';
import { ContinuousScroll } from '../engine/continuous.js';
import { Paragraphs } from '../engine/paragraphs.js';
import { injectReaderSettings } from './reader-settings.js';

/**
 * 阅读视图。
 *
 * 两种模式共用同一份已解析的章节 HTML，通过切换容器实现：
 *   page   —— CSS 多列分页，translateX 位移翻页
 *   scroll —— 连续流，scrollTop 推进
 *
 * 进度统一按「章内比例 ratio」存储，因此模式切换、字号变化、窗口缩放都不会丢位置。
 */

const PREFETCH_RANGE = 1;   // 前后预取章节数（缓存已解析章节，减少等待）

export class ReaderView {
  constructor({ state, bus, app }) {
    this.state = state;
    this.bus = bus;
    this.app = app;
    this.api = window.firmament;

    this.book = null;
    this.toc = [];
    this.chapterIndex = 0;
    this.chapter = null;
    this.ratio = 0;
    // 引擎（分页/连续流）当前实际装载的章。摸鱼期间 #app 隐藏时引擎
    // 不跟随逻辑位置，两者会短暂分叉；退出摸鱼靠它判断要不要重定位。
    this._engineChapterIndex = 0;
    this.paginator = null;
    this.scroller = null;
    this.continuous = null;
    this.autoTurner = null;
    this.autoscroll = false;
    this.sessionStart = Date.now();
    this.uiHidden = false;
    this.uiTimer = null;
    this.saveTimer = null;
    this.isLoading = false;
    this.drawerOpen = null;
    this.paragraphs = null;
    this._pendingResume = null;
    this._chapterCache = new Map();
    /** 用户是否正在直接拖动滚动条（拖动期间挂起会改写 scrollTop 的动作） */
    this._userSeeking = false;
  }

  /* ============================ 初始化 ============================ */

  async init() {
    this.paragraphs = new Paragraphs(this.state.settings);

    this.paginator = new Paginator({
      viewport: $('#readerViewport'),
      clip: $('#readerClip'),
      columns: $('#readerColumns'),
      paper: $('#readerPaper'),
      onChange: () => this.onPageChange(),
    });

    this.scroller = new Scroller({
      scroller: $('#readerScroll'),
      inner: $('#readerScrollInner'),
      onProgress: () => this.onScrollProgress(),
      onUserScroll: () => this.onUserInteract(),
    });
    this.scroller.onAutoEnd = () => this.stopAutoScroll(true);

    // 连续滚动排版器：负责跨章拼接与"当前位置 → (章号, 章内比例)"的换算
    this.continuous = new ContinuousScroll({
      scroller: this.scroller,
      inner: $('#readerScrollInner'),
      total: 0,
      fetch: (i) => this.fetchChapter(i),
      renderInner: (data) => this.buildChapterHtml(data, { nav: false }),
      onBlockReady: (node) => { this.applyParagraphEnhance(node); this.bindChapterInteractions(); },
      onPosition: (pos, data) => this.onContinuousPosition(pos, data),
    });

    // 自动滚动滚到内容末尾时，尝试接上下一章继续滚；返回 false 则停下
    this.scroller.onAutoNearEnd = () => this.extendForAutoScroll();

    this.autoTurner = new AutoTurner({
      interval: this.state.settings.autoTurnInterval || 20,
      onTurn: () => this.autoNextPage(),
    });

    injectReaderSettings(this);
    this.bindEvents();

    this.bus.on('route', (v) => { if (v !== 'reader') this.pauseAllAuto(); });
    this.bus.on('reader:step-font', (d) => this.stepFontSize(d));
    this.bus.on('reader:toggle-dark', () => this.toggleDark());
    this.bus.on('fonts:changed', () => this.reflow());
  }

  /* ============================ 打开 / 关闭 ============================ */

  async open(bookId, opts) {
    const o = opts || {};
    this.isLoading = true;
    this.showLoading(true);
    this.hideError();

    try {
      const book = this.state.books.find((b) => b.id === bookId);
      if (!book) throw new Error('书籍不存在');

      this.book = book;
      this._chapterCache.clear();
      this.continuous.clear();

      if (this.app) this.app.route('reader');

      // 目录与进度并行获取
      const [toc, progress] = await Promise.all([
        call(this.api.books.toc(bookId), { silent: true }),
        call(this.api.progress.get(bookId), { silent: true }),
      ]);

      if (!toc || !toc.length) throw new Error('这本书没有可读的章节内容');
      this.toc = toc;

      this.renderTitlebar();
      this.renderToc();
      this.renderSeekMarks();

      const target = o.resume !== false && progress ? progress : null;
      const startIndex = target && Number.isFinite(target.chapterIndex) ? clamp(target.chapterIndex, 0, toc.length - 1) : 0;
      const startRatio = target && Number.isFinite(target.ratio) ? target.ratio : 0;

      await this.loadChapter(startIndex, { ratio: startRatio, instant: true });

      this.sessionStart = Date.now();
      this.state.currentBookId = bookId;
      this.uiHidden = false;
      this.showUI(true);

      // 进入阅读后聚焦，保证键盘操作立刻可用
      setTimeout(() => { $('#reader').focus?.(); }, 80);

      if (o.resume !== false && progress && (progress.ratio || 0) > 0.01) {
        const pct = Math.round((progress.ratio || 0) * 100);
        toast(`已回到上次位置 · 第 ${startIndex + 1} 章 ${pct}%`, { duration: 1800 });
      }
    } catch (err) {
      this.showError(err && err.message ? err.message : '打开失败');
    } finally {
      this.isLoading = false;
      this.showLoading(false);
    }
  }

  close() {
    this.pauseAllAuto();
    this.saveProgress(true);
    this.closeDrawers();
    this.continuous.clear();
    this._chapterCache.clear();
    this.book = null;
    this.state.currentBookId = null;
    if (this.app) this.app.route('library');
    this.app.reloadBooks();
  }

  /* ============================ 章节加载 ============================ */

  async loadChapter(index, opts) {
    const o = opts || {};
    if (!this.book) return;
    if (index < 0 || index >= this.toc.length) return;

    this.chapterIndex = index;
    const data = await this.fetchChapter(index);
    this._engineChapterIndex = index;
    if (!data) throw new Error('章节内容读取失败');

    this.chapter = data;

    const columnsEl = $('#readerColumns');

    if (this.isScrollMode()) {
      // 滚动模式由 ContinuousScroll 负责整段流的装载与拼接，
      // 这里只在"跳章"等需要重建的场景下让它重新 mount。
      //
      // ⚠ 必须先切可见性：否则「打开书时设置本就是滚动模式」这条路径下，
      //   滚动容器会一直保持 index.html 里的 display:none，
      //   正文渲染完整但整屏空白（已实际踩过）。
      this.applyModeVisibility();
      this.ratio = o.instant ? (o.ratio || 0) : 0;
      await this.mountContinuous(index, this.ratio);
    } else {
      this.applyModeVisibility();
      const html = this.buildChapterHtml(data);
      columnsEl.innerHTML = html;
      this.applyParagraphEnhance(columnsEl);
      this.bindChapterInteractions();

      this.ratio = o.instant ? (o.ratio || 0) : 0;
      await this.applyModeLayout({ ratio: this.ratio, instant: !!o.instant });
    }

    this.renderTitlebar();
    this.markTocActive();
    this.prefetch(index);
    // 通知摸鱼视图：章节已变，伪装界面里的正文需要同步刷新
    this.bus.emit('reader:chapter', { index });
  }

  /** 带内存缓存的章节读取（连续滚动会频繁取相邻章，缓存能显著减少等待） */
  async fetchChapter(index) {
    if (index < 0 || index >= this.toc.length) return null;
    if (this._chapterCache.has(index)) return this._chapterCache.get(index);
    const data = await call(this.api.books.chapter(this.book.id, index), { silent: true });
    if (data) {
      this._chapterCache.set(index, data);
      // 简单上限，避免长时间阅读后缓存无限增长
      if (this._chapterCache.size > 24) {
        const firstKey = this._chapterCache.keys().next().value;
        if (firstKey !== index) this._chapterCache.delete(firstKey);
      }
    }
    return data;
  }

  /** 装载连续滚动流 */
  async mountContinuous(index, ratio) {
    this.continuous.total = this.toc.length;
    await this.continuous.mount(index, ratio);
    // 首次装载后可能还没填满一屏（章节很短），补足到能滚动为止
    for (let i = 0; i < 3; i++) {
      if (this.scroller.maxScroll() > 8) break;
      const ok = await this.continuous.extendDown();
      if (!ok) break;
    }
  }

  /** 连续滚动位置变化 */
  onContinuousPosition(pos, data) {
    if (pos.index !== this.chapterIndex) {
      this.chapterIndex = pos.index;
      if (data) this.chapter = data;
      this._engineChapterIndex = pos.index;
      this.renderTitlebar();
      this.markTocActive();
    }
    this.ratio = pos.ratio;
    this.updateProgressUI();
    this.scheduleSave();

    // ⚠ 用户正在拖动滚动条时，绝不能做任何"会改写 scrollTop"的动作。
    //
    //   连续流为了防跳动，会在拼接/裁剪后调用 scrollToPx 补偿位置。
    //   拖动滚动条的过程中每一帧都在触发 scroll → 这里 → trim()，
    //   一旦发生裁剪就会把用户刚拖到的位置**改写回原处** ——
    //   用户看到的就是"拖动滑块后自动弹回原位"。
    //   拖动期间只更新进度显示，装载动作全部推迟到松手后。
    if (this._userSeeking) return;

    // 位置变了就检查一下是否需要往两端拼接 / 裁剪
    this.continuous.ensureEdges();
    this.continuous.trim();
  }

  /**
   * 自动滚动接近内容末尾时的续接。
   *
   * ⚠ 必须同步返回"还能不能继续"，不能等 fetch。
   *   异步等待期间 rAF 会再次调用本函数，若那时因为加载中而返回 false，
   *   自动滚动就会在换章的一瞬间被误停 —— 表现就是"滚到章末就停了"。
   */
  extendForAutoScroll() {
    if (!this.isScrollMode()) return false;
    const next = this.continuous.lastIndex() + 1;
    if (next >= this.toc.length) return false;
    this.continuous.extendDown();   // 幂等，内部有锁
    return true;
  }

  /** 预取相邻章节，降低翻章等待 */
  prefetch(index) {
    for (let i = index - PREFETCH_RANGE; i <= index + PREFETCH_RANGE; i++) {
      if (i === index || i < 0 || i >= this.toc.length) continue;
      // 主进程有内存缓存，这里只是提前触发解析
      call(this.api.books.chapter(this.book.id, i), { silent: true });
    }
  }

  /** 组装章节 HTML */
  buildChapterHtml(data, opts) {
    const o = opts || {};
    // nav=false 用于连续滚动：章与章之间是无缝衔接的，
    // 每章都插一组「上一章/下一章」按钮反而打断阅读节奏，
    // 改成一条极轻的章节分隔线。
    const withNav = o.nav !== false;

    // ⚠ 防空（真实崩溃点）：data 在"书尚未打开 / 正在切模式 / 章节加载失败"
    //   时会是 null，而这里直接读 data.title —— 抛 TypeError 后
    //   applyModeLayout 整条链路中断：模式切不过去，界面停在半途，
    //   用户看到的就是"切了一下就崩了"。必须给出可渲染的兜底。
    if (!data) {
      return '<p class="reader-empty-hint">（内容加载中…）</p>';
    }

    const parts = [];
    if (data.title) {
      parts.push(`<h2 class="chapter-heading">${esc(data.title)}</h2>`);
    }
    parts.push(data.html || '<p>（本章无内容）</p>');

    if (!withNav) {
      if (data.index < data.total - 1) {
        const nextTitle = data.nextTitle ? esc(data.nextTitle) : '';
        parts.push(`<div class="chapter-break">
          <span class="chapter-break__line"></span>
          ${nextTitle ? `<span class="chapter-break__next">${nextTitle}</span>` : ''}
          <span class="chapter-break__line"></span>
        </div>`);
      }
      return parts.join('\n');
    }

    // 章末导航
    const prevDisabled = data.index <= 0 ? ' disabled' : '';
    const nextDisabled = data.index >= data.total - 1 ? ' disabled' : '';
    const prevLabel = data.prevTitle ? `上一章` : '已是第一章';
    const nextLabel = data.nextTitle ? `下一章` : '已是最后一章';

    parts.push(`<div class="chapter-nav">
      <button class="chapter-nav__btn chapter-nav__btn--prev"${prevDisabled}>${icon('chevronLeft', 15)}<span>${esc(prevLabel)}</span></button>
      <button class="chapter-nav__btn chapter-nav__btn--toc">${icon('list', 15)}<span>目录</span></button>
      <button class="chapter-nav__btn chapter-nav__btn--next"${nextDisabled}><span>${esc(nextLabel)}</span>${icon('chevronRight', 15)}</button>
    </div>`);

    return parts.join('\n');
  }

  /** 章节内的交互按钮 */
  bindChapterInteractions() {
    const handler = (e) => {
      const btn = e.target.closest('.chapter-nav__btn, a, img');
      if (!btn) return;
      if (btn.classList.contains('chapter-nav__btn--prev')) { e.stopPropagation(); this.prevChapter(); }
      else if (btn.classList.contains('chapter-nav__btn--next')) { e.stopPropagation(); this.nextChapter(); }
      else if (btn.classList.contains('chapter-nav__btn--toc')) { e.stopPropagation(); this.toggleToc(); }
      else if (btn.tagName === 'IMG') { e.stopPropagation(); this.previewImage(btn.src); }
    };
    // 事件委托挂在容器上，只绑一次；连续滚动新增的章节块也能自动生效
    ['#readerColumns', '#readerScrollInner'].forEach((sel) => {
      const node = $(sel);
      if (!node || node.dataset.interactionsBound === '1') return;
      node.dataset.interactionsBound = '1';
      node.addEventListener('click', handler);
    });
  }

  /* ============================ 排版应用 ============================ */

  /**
 * 切换「分页容器 / 滚动容器」的可见性。
 *
 * ⚠ 必须抽成独立方法，并在**所有进入阅读的路径**上调用。
 *
 * 踩过的坑：这段逻辑原本只写在 applyModeLayout 里，而 loadChapter 的滚动分支
 * 改成只调 mountContinuous 之后就不再经过 applyModeLayout —— 于是
 * 「打开书时设置本来就是滚动模式」这条路径下，从来没人执行过
 * scrollEl.style.display = ''，容器一直保持 index.html 里写死的 display:none。
 * 结果是：正文其实已经完全渲染好（两万多字都在 DOM 里），
 * 但用户看到的是一片空白。
 *
 * 冒烟测试当时测不出来，因为它走的是「先以翻页模式打开、再切到滚动」，
 * 切换动作恰好补上了 display —— 与用户的真实路径不同。
 */
  applyModeVisibility() {
    const mode = this.state.settings.pageMode || 'page';
    const viewport = $('#readerViewport');
    const scrollEl = $('#readerScroll');
    if (!viewport || !scrollEl) return;
    if (mode === 'scroll') {
      viewport.style.display = 'none';
      scrollEl.style.display = '';
      scrollEl.classList.toggle('is-smooth', false);
    } else {
      scrollEl.style.display = 'none';
      viewport.style.display = '';
    }
  }

  /** 依据当前模式应用布局 */
  async applyModeLayout(opts) {
    const o = opts || {};
    const mode = this.state.settings.pageMode || 'page';
    const ratio = o.ratio != null ? o.ratio : this.ratio;

    const columns = $('#readerColumns');

    this.applyModeVisibility();

    if (mode === 'scroll') {
      // 连续流由 ContinuousScroll 装载：它会按索引顺序拼好若干章，
      // 后续滚动过程中再按需向两端延伸，实现"一直滚下去"。
      await this.mountContinuous(this.chapterIndex, ratio);
      this.scroller.setSpeed(this.state.settings.scrollSpeed || 42);
      this.ratio = this.continuous.current().ratio;
    } else {
      this.continuous.clear();
      columns.innerHTML = this.buildChapterHtml(this.chapter);
      this.applyParagraphEnhance(columns);
      this.bindChapterInteractions();
      await this.paginator.fullReflow({
        toPage: Math.round(ratio * Math.max(1, this.paginator.pageCount - 1)),
        keepRatio: ratio > 0 && o.instant !== true,
      });
      if (o.instant) {
        // 首次进入：先测页数，再按比例定位
        await this.paginator.reflow({ toPage: Math.round(ratio * Math.max(1, this.paginator.pageCount - 1)) });
      }
      this.ratio = this.paginator.ratio();
    }

    this.applyAnimationClass();
    this.updateProgressUI();
  }

  /** 段落增强：处理超长段落、对话行、空行等（可读性优化） */
  applyParagraphEnhance(root) {
    if (!this.paragraphs) return;
    this.paragraphs.apply(root);
  }

  nextFrameTwice() {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  applyAnimationClass() {
    const reader = $('#reader');
    const anim = this.state.settings.pageAnimation || 'slide';
    reader.classList.remove('reader--anim-slide', 'reader--anim-fade', 'reader--anim-flip', 'reader--anim-none');
    reader.classList.add('reader--anim-' + anim);
    reader.style.setProperty('--page-dur', (this.state.settings.pageAnimationDuration || 260) + 'ms');
  }

  /** 重排（字号/字体/边距/主题变化时调用） */
  async reflow(opts) {
    if (!this.book || !this.chapter) return;
    this.paragraphs = new Paragraphs(this.state.settings);
    const preserve = opts && opts.preserveRatio != null ? opts.preserveRatio : this.ratio;

    if (this.state.settings.pageMode === 'scroll') {
      // 连续流：重建整段内容后按原位置重新定位。
      // 段落增强依赖新的字号/行距设置，所以必须重新渲染而不是只重测。
      if (this.continuous.active) {
        const pos = this.continuous.current();
        await this.mountContinuous(pos.index, pos.ratio);
        this.ratio = this.continuous.current().ratio;
      }
    } else {
      await this.paginator.reflow({
        toPage: Math.round(preserve * Math.max(1, this.paginator.pageCount - 1)),
        keepRatio: true,
      });
      this.ratio = this.paginator.ratio();
    }
    this.updateProgressUI();
  }

  /**
   * 按「第几章 + 章内比例」定位。全应用唯一的位置写回入口。
   *
   * ⚠ 为什么必须有它：scroll 模式下 Scroller.setRatio 的语义是
   *   「整条连续流的全局比例」，而 reader.ratio 是「章内比例」。
   *   此前迷你框/伪装界面直接把章内比例喂给 scroller.setRatio，
   *   主界面就被甩到全局流的同一比例处 —— 读到第七章时等于跳回
   *   全书前段（用户看到的"跳回刚打开的章节"）。
   *   这里统一走 continuous.gotoChapter（章感知），page 模式走 paginator。
   */
  async setChapterRatio(index, ratio) {
    if (!this.book || !this.toc.length) return;
    const idx = Math.max(0, Math.min(this.toc.length - 1, Math.round(index)));
    const r = Math.max(0, Math.min(1, ratio));

    // ⚠ 摸鱼期间 #app 是 display:none，分页/连续流的几何测量全部为 0。
    //   此时驱动引擎会把 pageCount/scrollTop 算坏，退出后位置就漂了。
    //   隐藏时只更新「逻辑位置」（章号+章内比例+章节内容），引擎等退出后再定位。
    const appHidden = !document.getElementById('app').getClientRects().length;
    if (appHidden) {
      if (idx !== this.chapterIndex) {
        const data = await this.fetchChapter(idx);
        if (data) {
          this.chapterIndex = idx;
          this.chapter = data;
          this.renderTitlebar();
          this.markTocActive();
        }
      }
      this.ratio = r;
      this.updateProgressUI();
      this.scheduleSave();
      return;
    }

    if (idx !== this.chapterIndex) {
      await this.gotoChapter(idx, r);
      this.ratio = r;
      this.updateProgressUI();
      this.scheduleSave();
      return;
    }

    this.ratio = r;
    // 引擎装载的章可能与逻辑章分叉（摸鱼隐藏期间只换了逻辑章）。
    // 此时 setRatio 会作用在旧章内容上，必须整章重定位。
    if (this._engineChapterIndex !== idx) {
      await this.gotoChapter(idx, r);
      this._engineChapterIndex = idx;
      this.updateProgressUI();
      this.scheduleSave();
      return;
    }
    if (this.isScrollMode()) {
      if (this.continuous && this.continuous.active) await this.continuous.gotoChapter(idx, r);
      else this.scroller.setRatio(r, false);
    } else {
      this.paginator.setRatio(r);
    }
    this._engineChapterIndex = idx;
    this.updateProgressUI();
    this.scheduleSave();
  }

  /* ============================ 翻页 / 滚动 ============================ */

  isScrollMode() {
    return (this.state.settings.pageMode || 'page') === 'scroll';
  }

  nextPage() {
    if (this.isScrollMode()) {
      // 滚动模式：按可视高度推进一屏；已在内容末尾则尝试接下一章
      const before = this.el_scrollTop();
      this.continuous.pageStep(1);
      if (this.el_scrollTop() <= before + 1 && this.continuous.lastIndex() < this.toc.length - 1) {
        this.continuous.extendDown();
      }
      this.onUserInteract();
      return;
    }
    const st = this.paginator.next();
    if (st.atEnd) this.nextChapter();
    else this.onUserInteract();
  }

  prevPage() {
    if (this.isScrollMode()) {
      const before = this.el_scrollTop();
      this.continuous.pageStep(-1);
      if (this.el_scrollTop() >= before - 1 && this.continuous.firstIndex() > 0) {
        this.continuous.extendUp();
      }
      this.onUserInteract();
      return;
    }
    const st = this.paginator.prev();
    if (st.atStart) this.prevChapter({ toEnd: true });
    else this.onUserInteract();
  }

  el_scrollTop() {
    const n = $('#readerScroll');
    return n ? n.scrollTop : 0;
  }

  async nextChapter() {
    if (this.chapterIndex >= this.toc.length - 1) {
      toast('已经是最后一章了');
      return;
    }
    await this.saveProgress(true);
    if (this.isScrollMode()) {
      // 连续模式下"下一章"= 滚到下一章开头（内容可能已拼接好）
      await this.continuous.gotoChapter(this.chapterIndex + 1, 0);
      this.ratio = this.continuous.current().ratio;
      this.onContinuousPosition(this.continuous.current(), this.continuous.currentData());
    } else {
      await this.loadChapter(this.chapterIndex + 1, { instant: false });
    }
  }

  async prevChapter(opts) {
    if (this.chapterIndex <= 0) {
      toast('已经是第一章了');
      return;
    }
    await this.saveProgress(true);
    if (this.isScrollMode()) {
      const targetRatio = opts && opts.toEnd ? 1 : 0;
      await this.continuous.gotoChapter(this.chapterIndex - 1, targetRatio);
      this.ratio = this.continuous.current().ratio;
      this.onContinuousPosition(this.continuous.current(), this.continuous.currentData());
      return;
    }
    await this.loadChapter(this.chapterIndex - 1, { instant: false });
    if (opts && opts.toEnd) {
      await this.paginator.reflow({ toPage: this.paginator.pageCount - 1 });
      this.ratio = this.paginator.ratio();
      this.updateProgressUI();
    }
  }

  async gotoChapter(index, ratio) {
    const i = clamp(Number(index) || 0, 0, this.toc.length - 1);
    await this.saveProgress(true);
    if (this.isScrollMode() && this.continuous.active) {
      // 连续流：优先在原地跳（内容多已装载），避免整段重建导致的闪烁
      await this.continuous.gotoChapter(i, ratio || 0);
      const pos = this.continuous.current();
      this.chapterIndex = pos.index;
      this._engineChapterIndex = pos.index;
      const d = this.continuous.currentData();
      if (d) this.chapter = d;
      this.renderTitlebar();
      this.markTocActive();
      this.ratio = pos.ratio;
      this.updateProgressUI();
    } else {
      await this.loadChapter(i, { instant: true, ratio: ratio || 0 });
    }
    this.closeDrawers();
  }

  /* ============================ 自动翻页 / 自动滚动 ============================ */

  toggleAutoTurn() {
    if (this.autoTurner.enabled) {
      this.autoTurner.stop();
      this.renderFabs();
      toast('已停止自动翻页');
      return;
    }
    const sec = this.state.settings.autoTurnInterval || 20;
    this.autoTurner.interval = sec;
    this.autoTurner.start();
    this.renderFabs();
    toast(`自动翻页已开启 · 每 ${sec} 秒一页`);
  }

  autoNextPage() {
    if (!this.book) return;
    const st = this.isScrollMode() ? null : this.paginator.state();
    if (st && st.pageIndex >= st.pageCount - 1) {
      if (this.chapterIndex < this.toc.length - 1) {
        this.loadChapter(this.chapterIndex + 1, { instant: false });
      } else {
        this.autoTurner.stop();
        this.renderFabs();
        toast('已读到全书结尾，自动翻页已停止', { duration: 3200 });
      }
      return;
    }
    this.nextPage();
  }

  toggleAutoScroll() {
    if (this.autoscroll) {
      this.stopAutoScroll(true);
      return;
    }
    // 自动滚动只在滚动模式有意义；在分页模式下自动切换到滚动
    if (!this.isScrollMode()) {
      this.setPageMode('scroll');
      toast('已切换到滚动模式以启用自动滚动', { duration: 2000 });
    }
    this.autoscroll = true;
    this.scroller.setSpeed(this.state.settings.scrollSpeed || 42);
    this.scroller.start();
    this.showAutoScrollIndicator();
    this.renderFabs();
    this.hideUI(true);
  }

  stopAutoScroll(notify) {
    if (!this.autoscroll) return;
    this.autoscroll = false;
    this.scroller.stop();
    this.hideAutoScrollIndicator();
    this.renderFabs();
    this.showUI(true);
    if (notify) toast('已停止自动滚动');
  }

  pauseAllAuto() {
    if (this.autoscroll) this.stopAutoScroll(false);
    if (this.autoTurner && this.autoTurner.enabled) {
      this.autoTurner.stop();
      this.renderFabs();
    }
  }

  /**
   * ⚠ 已移除「用户操作即暂停自动滚动」的机制（用户明确要求）。
   *
   *   历史包袱：最初 mousemove 一律暂停；后来改成"累计位移 >90px 才暂停"，
   *   再加 4.2 秒后自动恢复。但无论阈值怎么调，本质都是"鼠标一动就停" ——
   *   用户想安安静静挂着自动翻页，手一碰鼠标它就停了，体验极差。
   *
   *   现在的规则很简单：**自动滚动/自动翻页一旦开启就一直跑，
   *   只有用户显式点「暂停 / 停止」才停。** 鼠标移动、滚轮、
   *   拖动滚动条都不再打断它。
   *
   *   注意：`Scroller.togglePause()` 本身保留 —— 它是界面上那个
   *   暂停按钮的后端，属于"显式暂停"，与本机制无关。
   */
  showAutoScrollIndicator() {
    this.hideAutoScrollIndicator();
    const reader = $('#reader');
    const node = el('div.autoscroll-indicator', { id: 'autoScrollUI' }, [
      el('span.autoscroll-dot'),
      el('span', { text: '自动滚动中' }),
      (() => {
        const b = el('button', { html: icon('pause', 12), title: '暂停 / 继续' });
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const paused = this.scroller.togglePause();
          b.innerHTML = paused ? icon('play', 12) : icon('pause', 12);
          toast(paused ? '已暂停' : '已继续', { duration: 1200 });
        });
        return b;
      })(),
      (() => {
        const b = el('button', { html: icon('x', 12), title: '停止' });
        b.addEventListener('click', (e) => { e.stopPropagation(); this.stopAutoScroll(true); });
        return b;
      })(),
    ]);
    reader.appendChild(node);
  }

  hideAutoScrollIndicator() {
    const n = $('#autoScrollUI');
    if (n) n.remove();
  }

  /* ============================ 进度 ============================ */

  onPageChange() {
    this.ratio = this.paginator.ratio();
    this.updateProgressUI();
    this.scheduleSave();
    if (this.autoTurner.enabled) this.autoTurner.kick();
  }

  onScrollProgress() {
    if (!this.isScrollMode()) return;
    if (this.continuous.active) {
      // ⚠ 连续模式下必须在这里主动换算位置。
      //   否则滚动时进度/章节号不会更新（页面底部一直停在「第 1/N 章 0%」）。
      //   scroll 事件很密集，用 rAF 合并，避免每帧多次测量。
      if (this._posRaf) return;
      this._posRaf = requestAnimationFrame(() => {
        this._posRaf = null;
        if (!this.continuous.active || !this.isScrollMode()) return;
        const pos = this.continuous.current();
        this.onContinuousPosition(pos, this.continuous.currentData());
      });
      return;
    }
    this.ratio = this.scroller.ratio();
    this.updateProgressUI();
    this.scheduleSave();
  }

  updateProgressUI() {
    const total = this.toc.length;
    const chNo = this.chapterIndex + 1;
    const pct = Math.round(this.ratio * 100);

    // 全书进度：章节占比 + 章内占比
    const overall = total > 0 ? ((chNo - 1 + this.ratio) / total) * 100 : 0;

    if (this.isScrollMode()) {
      $('#rPos').textContent = `第 ${chNo} / ${total} 章 · ${pct}%`;
    } else {
      const st = this.paginator.state();
      $('#rPos').textContent = `第 ${st.pageIndex + 1} / ${st.pageCount} 页 · 第 ${chNo}/${total} 章`;
    }

    $('#rMeta').textContent = `全书 ${overall.toFixed(1)}%`;
    $('#rSeekFill').style.width = clamp(overall, 0, 100) + '%';

    // 迷你框进度线
    const miniLine = $('#bossMiniLine');
    if (miniLine) miniLine.style.width = clamp(overall, 0, 100) + '%';
  }

  /** 节流保存进度 */
  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveProgress(false), 900);
  }

  async saveProgress(immediate) {
    if (!this.book) return;
    clearTimeout(this.saveTimer);
    const sessionSec = Math.round((Date.now() - this.sessionStart) / 1000);
    this.sessionStart = Date.now();

    const st = this.paginator ? this.paginator.state() : null;
    const payload = {
      chapterIndex: this.chapterIndex,
      chapterTitle: (this.chapter && this.chapter.title) || '',
      ratio: this.ratio,
      pageIndex: st ? st.pageIndex : 0,
      pageCount: st ? st.pageCount : 1,
      mode: this.state.settings.pageMode,
      sessionSeconds: sessionSec > 0 ? Math.min(sessionSec, 7200) : 0,
    };
    await call(this.api.progress.set(this.book.id, payload), { silent: true });
    if (immediate) this.app.reloadBooks();
  }

  /* ============================ 界面显隐 ============================ */

  showUI(force) {
    if (force) this.uiHidden = false;
    $('#readerTopbar').classList.remove('is-hidden');
    $('#readerBottombar').classList.remove('is-hidden');
    $('#readerFabs').classList.remove('is-hidden');
    this.scheduleHideUI();
  }

  hideUI(force) {
    if (force) this.uiHidden = true;
    $('#readerTopbar').classList.add('is-hidden');
    $('#readerBottombar').classList.add('is-hidden');
    $('#readerFabs').classList.add('is-hidden');
    this.hideAutoScrollIndicator && null;
  }

  scheduleHideUI() {
    clearTimeout(this.uiTimer);
    this.uiTimer = setTimeout(() => {
      if (this.drawerOpen) return;
      if (this.autoscroll) { this.hideUI(true); return; }
      this.hideUI(false);
    }, 3200);
  }

  onUserInteract() {
    // ⚠ 不要再因用户操作而暂停自动滚动（见 autoscrollPauseByUser 的说明）。
    //   自动滚动运行期间连 UI 都不必唤起 —— 用户就是想让画面安静地自己走。
    if (this.autoscroll) return;
    // ⚠ 行为变更（用户明确要求）：滚动/翻页**不再**自动弹出工具栏，
    //   只有主动点击中部才会唤出（stage click 处理）。
    //   这里只负责重置自动翻页计时，避免"刚翻完立刻又被自动翻走"。
    if (this.autoTurner.enabled) this.autoTurner.kick();
  }

  /* ============================ 顶栏 / 底栏 ============================ */

  renderTitlebar() {
    const t = $('#rTitle');
    const c = $('#rChapter');
    t.textContent = this.book ? this.book.title : '';
    c.textContent = this.chapter
      ? `${this.chapter.title}${this.chapter.total ? `　(${this.chapterIndex + 1}/${this.chapter.total})` : ''}`
      : '';

    $('#rbtnBookmark').classList.toggle('is-on', this.isChapterBookmarked());
    $('#rbtnBoss').classList.toggle('is-on', this.app.boss && this.app.boss.isActive);
  }

  renderFabs() {
    const host = $('#readerFabs');
    clear(host);

    const mk = (iconName, title, onClick, active) => {
      const b = el('button.fab', { class: active ? 'is-on' : '', title, html: icon(iconName, 17) });
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      return b;
    };

    // 自动翻页 / 自动滚动
    if (this.isScrollMode()) {
      host.appendChild(mk(this.autoscroll ? 'pause' : 'scroll',
        this.autoscroll ? '停止自动滚动' : '开始自动滚动（慢慢向下滑）',
        () => this.toggleAutoScroll(), this.autoscroll));
    } else {
      host.appendChild(mk(this.autoTurner.enabled ? 'pause' : 'play',
        this.autoTurner.enabled ? `停止自动翻页（每 ${this.autoTurner.interval} 秒）` : '开始自动翻页',
        () => this.toggleAutoTurn(), this.autoTurner.enabled));
    }

    host.appendChild(mk('list', '目录 (Ctrl+T)', () => this.toggleToc(), this.drawerOpen === 'toc'));
    host.appendChild(mk('bookmark', '书签 (Ctrl+B)', () => this.toggleBookmark()));
    host.appendChild(mk('type', '阅读设置 (Ctrl+,)', () => this.toggleSettings(), this.drawerOpen === 'settings'));
  }

  /**
   * 阅读页窗口拖动：按住顶栏空白处即可移动窗口。
   *
   * ⚠ 与 mini 框的拖拽同源（见 views/boss.js#bindMiniDrag）：
   *   用自定义 mousedown/mousemove + IPC 移窗，而不是 CSS 拖拽区。
   *   原因是 CSS 拖拽区会吞掉点击事件 —— 顶栏中部正好是
   *   「点一下显隐工具栏」的热区，一旦变成拖拽区，点击就再也进不来。
   *
   * 判定规则（与系统窗口行为一致）：
   *   · 位移 < 4px  → 当作点击，交给原有逻辑（显隐工具栏 / 按钮）
   *   · 位移 ≥ 4px  → 开始拖窗，并抑制随后那次 click
   */
  bindWindowDrag() {
    const bar = $('#readerTopbar');
    if (!bar) return;

    let armed = false;
    let dragging = false;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;

    const onDown = (e) => {
      if (e.button !== 0) return;
      // 按钮、输入框、链接等交互元素一律不参与拖拽
      if (e.target.closest('button, input, a, select, .rbtn, .drawer')) return;
      armed = true;
      dragging = false;
      moved = 0;
      lastX = e.screenX;
      lastY = e.screenY;
    };

    const onMove = (e) => {
      if (!armed) return;
      const dx = e.screenX - lastX;
      const dy = e.screenY - lastY;
      lastX = e.screenX;
      lastY = e.screenY;
      moved += Math.abs(dx) + Math.abs(dy);

      if (!dragging && moved > 4) {
        dragging = true;
        document.body.classList.add('is-dragging-window');
      }
      if (dragging) this.api.app.moveBy(dx, dy);
    };

    const onUp = () => {
      if (!armed) return;
      if (dragging) {
        // 抑制紧随其后的 click，避免"拖完窗口顺手翻了一页"
        this._suppressStageClick = Date.now() + 200;
      }
      armed = false;
      dragging = false;
      document.body.classList.remove('is-dragging-window');
    };

    bar.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  /**
   * 摸鱼模式入口菜单。
   *
   * ⚠ 为什么要加这个：伪装界面（Word / Excel / VS Code / 邮件）的选择项
   *   此前只存在于「设置 → 摸鱼模式」里，而阅读页顶栏那个按钮是**直接按上次
   *   设置进入**的 —— 用户点下去只会看到同一个界面，压根无从发现还有其他
   *   伪装形态可换。入口藏得太深，等于没有。
   *
   * 现在点顶栏按钮即弹出清单：一眼看到全部形态，选哪个就进哪个；
   * 顺带提供"进入后能怎么退出"的提示，避免进得去出不来。
   */
  openBossMenu() {
    const host = $('#modalHost');
    const cur = (this.state.settings.bossMode) || 'fake-word';

    const ITEMS = [
      { key: 'fake-word', label: 'Word 文档', desc: '一份会议纪要，正文即小说，最不引人注意' },
      { key: 'fake-excel', label: 'Excel 表格', desc: '数据表 + 备注列，小说藏在备注列里' },
      { key: 'fake-code', label: 'VS Code', desc: 'notes.md 里就是正文，带 minimap 与终端' },
      { key: 'fake-mail', label: 'Outlook 邮件', desc: '三栏邮件客户端，邮件正文即小说' },
      { key: 'mini-text', label: '纯文字迷你框', desc: '一个小方框只有正文，左下/右下角可拖拽调大小' },
      { key: 'mini-overlay', label: '透明迷你框', desc: '背景全透明，文字直接浮在桌面上，可拖拽缩放' },
    ];

    const list = el('div.boss-menu');
    ITEMS.forEach((m) => {
      const row = el('button.boss-menu__item', {
        class: m.key === cur ? 'is-active' : '',
      }, [
        el('span.boss-menu__icon', { html: icon(/^mini-/.test(m.key) ? 'ghost' : 'layout', 16) }),
        el('span.boss-menu__text', {}, [
          el('span.boss-menu__label', { text: m.label }),
          el('span.boss-menu__desc', { text: m.desc }),
        ]),
      ]);
      row.addEventListener('click', async () => {
        overlay.remove();
        // 迷你框 → square；透明浮窗 → overlay；其余伪装界面 → normal
        const style = m.key === 'mini-text' ? 'square'
          : (m.key === 'mini-overlay' ? 'overlay' : 'normal');
        this.app.patchSettings({ bossMode: m.key, bossStyle: style });
        await this.app.boss.enter({ mode: m.key, style });
        toast('已进入' + m.label + ' · 按 Esc 或点右上角 × 退出', { duration: 2600 });
      });
      list.appendChild(row);
    });

    const modal = el('div.modal.modal--sm', {}, [
      el('div.modal__head', {}, [
        el('div', {}, [
          el('h2.modal__title', { text: '摸鱼模式' }),
          el('p.modal__desc', { text: '选一种伪装形态，瞬间切换。退出方式：Esc ／ 右上角 × ／ 右键 ／ 老板键。' }),
        ]),
        (() => {
          const b = el('button.btn.btn--icon.btn--sm', { html: icon('x', 15), title: '关闭' });
          b.addEventListener('click', () => overlay.remove());
          return b;
        })(),
      ]),
      el('div.modal__body', {}, list),
    ]);

    const overlay = el('div.overlay', {}, modal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    host.appendChild(overlay);
  }

  renderSeekMarks() {
    const host = $('#rSeekMarks');
    clear(host);
    // 在总进度条上标出每章边界，大量章节时抽样避免密集
    const total = this.toc.length;
    if (total < 2) return;
    const maxMarks = 90;
    const step = Math.max(1, Math.floor(total / maxMarks));
    for (let i = step; i < total; i += step) {
      const pct = (i / total) * 100;
      host.appendChild(el('div.reader-seek__mark', { style: { left: pct + '%' } }));
    }
  }

  /* ============================ 目录 ============================ */

  renderToc(filter) {
    const host = $('#tocList');
    clear(host);
    const q = (filter || '').trim().toLowerCase();
    const list = q ? this.toc.filter((c) => c.title.toLowerCase().includes(q)) : this.toc;

    if (!list.length) {
      host.appendChild(el('div.drawer-empty', {}, [
        el('span', { html: icon('search', 22), style: { display: 'flex' } }),
        el('span', { text: '没有匹配的章节' }),
      ]));
      return;
    }

    $('#tocCount').textContent = `${this.toc.length} 章`;

    const frag = document.createDocumentFragment();
    list.forEach((c) => {
      const node = el('button.toc-item', {
        class: c.index === this.chapterIndex ? 'is-active' : '',
        dataset: { index: c.index },
      }, [
        el('span.toc-item__idx', { text: String(c.index + 1) }),
        el('span.toc-item__title', { text: c.title || `第 ${c.index + 1} 章` }),
        c.index === this.chapterIndex ? el('span.toc-item__dot') : null,
      ]);
      node.addEventListener('click', () => this.gotoChapter(c.index));
      frag.appendChild(node);
    });
    host.appendChild(frag);

    const active = host.querySelector('.toc-item.is-active');
    if (active) {
      requestAnimationFrame(() => {
        active.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
  }

  markTocActive() {
    $$('#tocList .toc-item').forEach((n) => {
      const i = Number(n.dataset.index);
      n.classList.toggle('is-active', i === this.chapterIndex);
      const dot = n.querySelector('.toc-item__dot');
      if (i === this.chapterIndex && !dot) n.appendChild(el('span.toc-item__dot'));
      if (i !== this.chapterIndex && dot) dot.remove();
    });
  }

  toggleToc() {
    this.toggleDrawer('toc');
  }

  /* ============================ 搜索 ============================ */

  openSearch() {
    this.toggleDrawer('search', true);
    setTimeout(() => $('#readerSearchInput').focus(), 200);
  }

  async doSearch(keyword) {
    const host = $('#searchResults');
    clear(host);
    const kw = String(keyword || '').trim();
    if (!kw) {
      host.appendChild(el('div.drawer-empty', {}, el('span', { text: '输入关键词后按回车搜索全书' })));
      return;
    }

    host.appendChild(el('div.drawer-empty', {}, [
      el('div.spinner', { style: { width: '22px', height: '22px' } }),
      el('span', { text: '正在搜索…' }),
    ]));

    const results = await call(this.api.books.search(this.book.id, kw, 'content'));
    clear(host);

    if (!results || !results.length) {
      host.appendChild(el('div.drawer-empty', {}, [
        el('span', { html: icon('search', 22), style: { display: 'flex' } }),
        el('span', { text: `没有找到「${kw}」` }),
      ]));
      return;
    }

    const re = new RegExp('(' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    results.forEach((r) => {
      const node = el('button.result-item', {}, [
        el('div.result-item__chapter', { text: `第 ${r.chapterIndex + 1} 章 · ${r.chapterTitle}` }),
        el('div.result-item__snippet', {
          html: esc(r.snippet).replace(re, '<mark>$1</mark>'),
        }),
      ]);
      node.addEventListener('click', () => {
        this.gotoChapter(r.chapterIndex, r.percent || 0);
        this.closeDrawers();
        if (r.snippet) toast(`已跳转到第 ${r.chapterIndex + 1} 章`, { duration: 1600 });
      });
      host.appendChild(node);
    });
  }

  /* ============================ 书签 ============================ */

  async isChapterBookmarked() {
    if (!this.book) return false;
    const list = await call(this.api.bookmarks.list(this.book.id), { silent: true });
    return !!(list && list.some((b) => b.chapterIndex === this.chapterIndex));
  }

  async toggleBookmark() {
    if (!this.book || !this.chapter) return;
    const list = await call(this.api.bookmarks.list(this.book.id), { silent: true }) || [];
    const existing = list.find((b) => b.chapterIndex === this.chapterIndex);

    if (existing) {
      await call(this.api.bookmarks.remove(this.book.id, existing.id));
      toast('已取消本章书签');
    } else {
      const snippet = (this.chapter.html || '').replace(/<[^>]+>/g, '').slice(0, 90).trim();
      await call(this.api.bookmarks.add(this.book.id, {
        chapterIndex: this.chapterIndex,
        chapterTitle: this.chapter.title,
        percent: this.ratio,
        snippet,
      }));
      toast.success('已添加书签');
    }
    $('#rbtnBookmark').classList.toggle('is-on', !existing);
    this.renderBookmarks();
  }

  async renderBookmarks() {
    const host = $('#bookmarkList');
    clear(host);
    if (!this.book) return;
    const list = await call(this.api.bookmarks.list(this.book.id), { silent: true }) || [];

    if (!list.length) {
      host.appendChild(el('div.drawer-empty', {}, [
        el('span', { html: icon('bookmark', 22), style: { display: 'flex' } }),
        el('span', { text: '还没有书签' }),
        el('span.text-xs', { text: '阅读时按 Ctrl+B 或点顶部书签图标添加' }),
      ]));
      return;
    }

    list.forEach((b) => {
      const node = el('button.bookmark-item', {}, [
        el('div.bookmark-item__body', {}, [
          el('div.bookmark-item__chapter', { text: `第 ${b.chapterIndex + 1} 章 · ${b.chapterTitle || ''}` }),
          b.snippet ? el('div.bookmark-item__text', { text: b.snippet }) : null,
          el('div.bookmark-item__time', { text: fmtRelative(b.createdAt) }),
        ]),
        (() => {
          const d = el('span.bookmark-item__del', { html: icon('x', 13), title: '删除' });
          d.addEventListener('click', async (e) => {
            e.stopPropagation();
            await call(this.api.bookmarks.remove(this.book.id, b.id));
            this.renderBookmarks();
            this.renderTitlebar();
            toast('已删除书签');
          });
          return d;
        })(),
      ]);
      node.addEventListener('click', () => {
        this.gotoChapter(b.chapterIndex, b.percent || 0);
        this.closeDrawers();
      });
      host.appendChild(node);
    });
  }

  /* ============================ 抽屉管理 ============================ */

  toggleDrawer(name, force) {
    const map = {
      toc: { el: $('#drawerToc'), render: () => this.renderToc() },
      search: { el: $('#drawerSearch'), render: () => {} },
      bookmarks: { el: $('#drawerBookmarks'), render: () => this.renderBookmarks() },
      settings: { el: $('#drawerSettings'), render: () => this.mountReaderSettings() },
    };
    const target = map[name];
    if (!target) return;

    const opening = force === true ? true : (force === false ? false : this.drawerOpen !== name);
    this.closeDrawers();

    if (opening) {
      this.drawerOpen = name;
      target.el.classList.add('is-open');
      target.render();
    }
    // 左侧抽屉会占用正文空间：让正文区真正缩窄并重排，
    // 而不是被浮层覆盖切断（覆盖式会让右侧残留半截文字，像坏了）
    $('#reader').classList.toggle('is-left-drawer', this.isLeftDrawerOpen());
    this.renderFabs();
    this.reflowForViewportChange();
  }

  isLeftDrawerOpen() {
    return ['toc', 'search', 'bookmarks'].includes(this.drawerOpen);
  }

  /**
   * 视图可用宽度变化时重排。
   * 抽屉开关会改变正文可见区域，不重排就会出现"文字被抽屉切断"。
   * 用 rAF 等抽屉动画起步后再测，避免量到过渡中的尺寸。
   */
  reflowForViewportChange() {
    clearTimeout(this._drawerReflowTimer);
    this._drawerReflowTimer = setTimeout(async () => {
      if (!this.book || this.state.view !== 'reader') return;
      if (this.isScrollMode()) {
        this.ratio = this.scroller.ratio();
      } else {
        await this.paginator.reflow({ keepRatio: true });
        this.ratio = this.paginator.ratio();
      }
      this.updateProgressUI();
    }, 320);
  }

  closeDrawers() {
    const wasOpen = !!this.drawerOpen;
    ['#drawerToc', '#drawerSearch', '#drawerBookmarks', '#drawerSettings'].forEach((s) => {
      const n = $(s);
      if (n) n.classList.remove('is-open');
    });
    this.drawerOpen = null;
    const readerEl = $('#reader');
    if (readerEl) readerEl.classList.remove('is-left-drawer');
    this.renderFabs();
    if (wasOpen) this.reflowForViewportChange();
  }

  handleEscape() {
    if (this.drawerOpen) { this.closeDrawers(); return true; }
    if (this.autoscroll) { this.stopAutoScroll(true); return true; }
    if (this.autoTurner.enabled) { this.autoTurner.stop(); this.renderFabs(); toast('已停止自动翻页'); return true; }
    if (this.state.view === 'reader') { this.close(); return true; }
    return false;
  }

  toggleSettings() {
    this.toggleDrawer('settings');
  }

  mountReaderSettings() {
    if (this._mountSettings) this._mountSettings();
  }

  /* ============================ 设置项操作 ============================ */

  setPageMode(mode) {
    if (this.state.settings.pageMode === mode) return;
    const keep = this.ratio;
    this.app.patchSettings({ pageMode: mode });
    this.pauseAllAuto();
    this.applyModeLayout({ ratio: keep }).then(() => {
      this.updateProgressUI();
      this.app.renderTitlebar();
      this.renderFabs();
      this.app.settingsView && this.app.settingsView.syncFromState();
    });
  }

  toggleDark() {
    const next = this.app.theme.toggleDark();
    this.app.patchSettings({ theme: next });
    toast(next === 'night' ? '夜间模式' : '日间模式', { duration: 1200 });
    this.app.settingsView && this.app.settingsView.syncFromState();
  }

  stepFontSize(delta) {
    const cur = this.state.settings.fontSize || 19;
    const next = clamp(Math.round(cur + delta * 1), 12, 40);
    if (next === cur) return;
    this.app.patchSettings({ fontSize: next });
    this.reflow();
    this.app.settingsView && this.app.settingsView.syncFromState();
    toast(`字号 ${next}px`, { duration: 1100 });
  }

  async previewImage(src) {
    const host = $('#modalHost');
    const img = el('img', { src, style: { maxWidth: '92vw', maxHeight: '86vh', objectFit: 'contain', borderRadius: '8px' } });
    const overlay = el('div.overlay', { style: { background: 'rgba(0,0,0,.86)' } }, img);
    overlay.addEventListener('click', () => overlay.remove());
    host.appendChild(overlay);
  }

  /* ============================ 事件绑定 ============================ */

  bindEvents() {
    // 顶栏
    $('#rbtnBack').addEventListener('click', () => this.close());
    // 摸鱼模式：点一下直接按上次的设置进入（老用户习惯不变）；
    // 想换伪装界面时，用这里的菜单现选 —— 此前入口只藏在设置页，
    // 用户在阅读页根本找不到「伪装成 Word/Excel/VS Code」的开关。
    $('#rbtnBoss').addEventListener('click', (e) => {
      e.stopPropagation();
      this.openBossMenu();
    });
    $('#rbtnSearch').addEventListener('click', () => this.openSearch());
    $('#rbtnBookmark').addEventListener('click', () => this.toggleBookmark());
    $('#rbtnFullscreen').addEventListener('click', async () => {
      const cur = await this.api.app.isFullScreen();
      await this.api.app.setFullScreen(!(cur && cur.data));
    });
    $('#rbtnMore').addEventListener('click', () => this.toggleSettings());

    // 抽屉关闭
    $('#tocClose').addEventListener('click', () => this.closeDrawers());
    $('#searchClose').addEventListener('click', () => this.closeDrawers());
    $('#bmClose').addEventListener('click', () => this.closeDrawers());
    $('#rsClose').addEventListener('click', () => this.closeDrawers());

    // 目录搜索 / 倒序
    $('#tocSearch').addEventListener('input', debounce((e) => this.renderToc(e.target.value), 200));
    let tocReversed = false;
    $('#tocSort').addEventListener('click', () => {
      tocReversed = !tocReversed;
      this.toc.reverse();
      this.chapterIndex = this.toc.length - 1 - this.chapterIndex;
      this.renderToc($('#tocSearch').value);
      toast(tocReversed ? '目录已倒序' : '目录已正序', { duration: 1200 });
    });

    // 搜索
    const si = $('#readerSearchInput');
    si.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.doSearch(si.value);
    });

    // 热区点击：翻页 / 切换 UI。
    //
    // ⚠ 热区本身已设 pointer-events:none（见 reader.css），
    //   点击必须落在 .reader-stage 上再按坐标判定。原因是热区若接收事件，
    //   会同时吞掉滚轮与正文里的按钮点击 —— 那是"滚轮不滚、按钮点不了"的根因。
    const stage = $('#readerStage');
    stage.addEventListener('click', (e) => {
      // 交互元素一律放行：正文里的上一章/下一章/目录按钮、链接、图片
      if (e.target.closest('.chapter-nav__btn, a, img, button, .reader-fabs, .drawer, .modal, .overlay')) return;
      // 有文字选中时不当作翻页点击（用户多半想复制/划线）
      if (getSelectionText($('#reader'))) return;
      if (this.drawerOpen) { this.closeDrawers(); return; }

      // 刚拖完窗口的那一下不要在正文里触发翻页
      if (this._suppressStageClick && Date.now() < this._suppressStageClick) return;

      const rect = stage.getBoundingClientRect();
      const x = e.clientX - rect.left;
      // 上下各留出工具条区域，避免点顶栏/底栏时误触发翻页
      const fx = x / Math.max(1, rect.width);

      if (fx < 0.22) this.prevPage();
      else if (fx > 0.78) this.nextPage();
      else {
        this.uiHidden = !this.uiHidden;
        this.uiHidden ? this.hideUI(true) : this.showUI(true);
      }
    });

    // 阅读页的窗口拖动。
    //
    // ⚠ 为什么不用 CSS 的 -webkit-app-region: drag：
    //   阅读页顶栏虽然设了 drag，但中间一大片是「点一下切换工具栏」的
    //   热区，正文区更是要点两侧翻页 —— 这些地方都不能变成拖拽区，
    //   否则翻页/唤出工具栏就全废了。可用户又确实需要「按住任何空白处
    //   就能把窗口拖走」（尤其是顶栏中部，那里看着就像标题栏）。
    //
    //   做法：在顶栏空白区域监听按下/移动，用位移阈值区分意图 ——
    //   移动超过 4px 视为拖窗口（并把这次点击作废，不触发按钮），
    //   否则当作普通点击放行给原有逻辑。
    this.bindWindowDrag();

    // 阅读区鼠标移动 —— 刻意**不**唤起工具栏。
    //
    // ⚠ 行为变更（用户明确要求）：
    //   以前移动鼠标就会把顶栏/底栏弹出来，滚动阅读时鼠标稍有动作
    //   工具栏就闪一下，非常干扰。现在滚动（以及任何鼠标移动）
    //   都不会显示工具栏，**只有主动点击**才会唤出（见下方 stage 点击）。
    //
    //   保留一个窄例外：工具栏已经显示时，鼠标在顶栏/底栏区域内移动
    //   可以延长它的停留时间 —— 用户正要去点按钮，别让它中途消失。
    const reader = $('#reader');
    reader.addEventListener('mousemove', rafThrottle((e) => {
      if (this.autoscroll) return;
      if (this.uiHidden) return;                 // 隐藏状态下鼠标移动不再唤起
      const bar = e.target.closest && e.target.closest('#readerTopbar, #readerBottombar, .reader-fabs');
      if (bar) this.scheduleHideUI();            // 已显示且鼠标在工具条上 → 延长
    }));
    reader.addEventListener('mouseleave', () => {
      if (this.drawerOpen) return;
      if (this.autoscroll) return;
      if (!this.uiHidden) this.scheduleHideUI();
    });

    // 滚轮。
    //   · 滚动模式：接管并做"小步 + 缓动"，避免原生一次滚太多
    //   · 分页模式：滚轮翻页
    reader.addEventListener('wheel', (e) => {
      const inDrawer = e.target.closest('.drawer, .modal, .overlay, .toc-list, .search-results, .drawer__body');
      if (inDrawer) return;                 // 抽屉内部保留原生滚动
      if (this.drawerOpen && !this.isScrollMode()) return;

      if (this.isScrollMode()) {
        // 触控板（deltaMode=0 且数值很小）保留原生手感，不做缩放
        const raw = this.scroller.normalizeWheelDelta(e);
        const isTrackpad = (e.deltaMode || 0) === 0 && Math.abs(e.deltaY) < 40;

        if (isTrackpad) {
          // 原生滚 + 到边缘时拼接相邻章
          this.continuous.ensureEdges();
          return;
        }

        // ⚠ 自动滚动期间不接管滚轮：交给浏览器原生滚动即可。
        //   这样用户想手动微调位置时不会被"缓动"抢走控制权，
        //   而自动滚动本身仍在继续（不再因为滚一下就停）。
        if (this.autoscroll) return;

        e.preventDefault();
        const handled = this.scroller.wheelScroll(e);
        if (handled) {
          this.continuous.ensureEdges();
          // 滚动阅读时不唤出工具栏（用户要求）；若正显示则收起
          if (!this.autoscroll) {
            if (!this.uiHidden) this.hideUI(true);
            // 自动翻页的计时仍要重置
            if (this.autoTurner.enabled) this.autoTurner.kick();
          }
        }
        return;
      }

      e.preventDefault();
      const now = Date.now();
      if (this._lastWheel && now - this._lastWheel < 60) return;
      if (Math.abs(e.deltaY) < 4) return;
      this._lastWheel = now;
      if (e.deltaY > 0) this.nextPage();
      else this.prevPage();
    }, { passive: false });

    // ⚠ 拖动滚动条**不再暂停自动滚动**（用户明确要求取消自动暂停）。
    //   保留这段监听的唯一意义是：拖动期间挂起"位置写回"，防止
    //   连续流的补偿逻辑把用户拖到的位置覆盖回原处（见下方 _userSeeking）。
    {
      const scrollEl = $('#readerScroll');
      let seeking = false;

      const endSeek = () => {
        if (!seeking) return;
        seeking = false;
        this._userSeeking = false;
        // 松手后再补一次拼接判断（拖动过程中是被挂起的）
        this.continuous.ensureEdges();
      };

      scrollEl.addEventListener('mousedown', (e) => {
        const rect = scrollEl.getBoundingClientRect();
        // 距右边界 14px 内视为落在滚动条上
        if (rect.right - e.clientX <= 14) {
          seeking = true;
          this._userSeeking = true;
          // 拖动滚动条时取消尚未完成的滚轮缓动，避免两股力量互相拉扯
          this.scroller.cancelWheelEase();
        }
      });
      document.addEventListener('mouseup', endSeek);
      scrollEl.addEventListener('scroll', () => {
        if (seeking) this._userSeeking = true;
      }, { passive: true });
      // 触屏拖动同样视为"用户正在直接定位"
      scrollEl.addEventListener('touchstart', () => {
        this._userSeeking = true;
        this.scroller.cancelWheelEase();
      }, { passive: true });
      scrollEl.addEventListener('touchend', endSeek, { passive: true });
    }

    // 键盘：方向键 / 翻页键 / 空格
    on(document, 'keydown', (e) => {
      if (this.state.view !== 'reader') return;
      // ⚠ 摸鱼激活时完全让位：伪装界面/迷你框有自己的翻页语义，
      //   阅读器若继续执行 nextPage()/prevPage()，会和伪装容器的滚动
      //   互相覆盖（双 handler 都 preventDefault），表现为翻页失灵。
      //   boss.js 侧另有 stopPropagation 做第一道防线，这里是双保险。
      if (this.app && this.app.boss && this.app.boss.isActive) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;

      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          e.preventDefault();
          if (e.shiftKey && e.key === ' ') this.prevPage();
          else this.nextPage();
          break;
        case 'ArrowDown':
          // 滚动模式下方向键做"小步滚动"，更符合上下滑动的直觉
          e.preventDefault();
          if (this.isScrollMode()) {
            this.scroller.scrollToPx(this.el_scrollTop() + 90);
            this.continuous.ensureEdges();
            this.onUserInteract();
          } else this.nextPage();
          break;
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault();
          this.prevPage();
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (this.isScrollMode()) {
            this.scroller.scrollToPx(this.el_scrollTop() - 90);
            this.continuous.ensureEdges();
            this.onUserInteract();
          } else this.prevPage();
          break;
        case 'Home':
          e.preventDefault();
          this.gotoChapter(0, 0);
          break;
        case 'End':
          e.preventDefault();
          this.gotoChapter(this.toc.length - 1, 1);
          break;
        default:
          break;
      }
    });

    // 进度条拖动
    const seek = $('#rSeek');
    const onSeek = (e) => {
      const rect = seek.getBoundingClientRect();
      const r = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const targetChapter = clamp(Math.floor(r * this.toc.length), 0, this.toc.length - 1);
      const chapterRatio = (r * this.toc.length) - targetChapter;
      this.gotoChapter(targetChapter, clamp(chapterRatio, 0, 1));
    };
    seek.addEventListener('click', onSeek);

    // 触摸 / 拖拽进度（简化：按住移动）
    let seeking = false;
    seek.addEventListener('mousedown', (e) => {
      seeking = true;
      onSeek(e);
      const move = (ev) => { if (seeking) onSeek(ev); };
      const up = () => { seeking = false; document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    // 选中文字弹出快捷操作
    on(document, 'mouseup', (e) => {
      if (this.state.view !== 'reader') return;
      const sel = getSelectionText($('#reader'));
      if (!sel || sel.length < 2) { this.removeSelectionMenu(); return; }
      if (e.target.closest('.drawer, .modal, .overlay')) return;
      this.showSelectionMenu(e.clientX, e.clientY, sel);
    });

    // 窗口尺寸变化 → 重排（防抖）
    this._onResize = debounce(async () => {
      if (!this.book || this.state.view !== 'reader') return;
      if (this.isScrollMode()) {
        if (this.continuous.active) {
          await this.continuous.remeasure();
          this.ratio = this.continuous.current().ratio;
        } else {
          this.ratio = this.scroller.ratio();
        }
        this.updateProgressUI();
      } else {
        await this.paginator.reflow({ keepRatio: true });
        this.ratio = this.paginator.ratio();
        this.updateProgressUI();
      }
    }, 220);
    on(window, 'resize', this._onResize);

    // 页面卸载前保存
    on(window, 'beforeunload', () => { this.saveProgress(false); });
  }

  /** 选中文字快捷菜单 */
  showSelectionMenu(x, y, text) {
    this.removeSelectionMenu();
    const host = $('#ctxMenuHost');

    const mk = (label, iconName, fn) => {
      const b = el('button.context-menu__item', {}, [
        el('span', { html: icon(iconName, 15), style: { display: 'flex' } }),
        el('span', { text: label }),
      ]);
      b.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
      return b;
    };

    const menu = el('div.context-menu', {}, [
      mk('复制', 'file', () => {
        navigator.clipboard.writeText(text).then(() => toast.success('已复制')).catch(() => toast.error('复制失败'));
        this.removeSelectionMenu();
      }),
      mk('搜索这段文字', 'search', () => {
        $('#readerSearchInput').value = text.slice(0, 30);
        this.openSearch();
        this.doSearch(text.slice(0, 30));
        this.removeSelectionMenu();
      }),
      mk('添加书签', 'bookmark', () => {
        this.toggleBookmark();
        this.removeSelectionMenu();
      }),
    ]);

    host.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
    menu.style.top = Math.min(y + 8, window.innerHeight - rect.height - 8) + 'px';
  }

  removeSelectionMenu() {
    const host = $('#ctxMenuHost');
    if (host) clear(host);
  }

  /* ============================ 加载 / 错误 ============================ */

  showLoading(v) {
    $('#readerLoading').classList.toggle('hidden', !v);
  }

  showError(msg) {
    $('#readerError').classList.remove('hidden');
    $('#readerErrorDesc').textContent = msg || '';
    $('#btnReaderErrorBack').onclick = () => this.close();
    $('#btnReaderErrorRetry').onclick = () => {
      this.hideError();
      if (this.book) this.open(this.book.id);
    };
  }

  hideError() {
    $('#readerError').classList.add('hidden');
  }
}
