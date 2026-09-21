import { $, $$, el, clear, on, esc, debounce, fmtNum, delegate } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { toast, call } from './lib/toast.js';
import { ThemeManager, THEMES, TEXTURES, SKINS } from './lib/theme.js';
import { BookshelfView } from './views/bookshelf.js';
import { ReaderView } from './views/reader.js';
import { SettingsView } from './views/settings.js';
import { BossView } from './views/boss.js';
import { Keymap, matches } from './lib/keymap.js';

const api = window.firmament;

/**
 * 应用状态中心。所有视图共享同一份，避免各自维护副本导致不一致。
 */
export const State = {
  books: [],
  settings: {},
  fonts: [],
  recent: [],
  view: 'library',
  currentBookId: null,
  viewMode: 'grid',
  shelfFilter: { type: 'all', value: null, search: '' },
  sort: 'recent',
  missing: [],
};

export const Bus = {
  handlers: new Map(),
  /** 订阅者异常不冒泡：一个视图出错不应拖垮其他订阅者 */
  on(evt, fn) {
    if (!this.handlers.has(evt)) this.handlers.set(evt, new Set());
    this.handlers.get(evt).add(fn);
    return () => this.handlers.get(evt).delete(fn);
  },
  emit(evt, payload) {
    const set = this.handlers.get(evt);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[bus] ${evt} 订阅者异常：`, err && err.stack ? err.stack : err);
      }
    }
  },
};

export const App = {
  theme: null,
  bookshelf: null,
  reader: null,
  settingsView: null,
  boss: null,

  async init() {
    this.theme = new ThemeManager(State.settings);
    /** 快捷键表（settings.keybindings 里的用户自定义优先） */
    this.keymap = new Keymap(State.settings);
    this.theme.bind($('#readerBgTex') ? { querySelector: () => $('#readerBgTex') } : null);

    this.applyStaticIcons();
    this.bindWindowControls();
    this.bindGlobalKeys();
    this.bindIpcEvents();

    // 并行拉取初始数据
    const [settings, books, fonts, recent] = await Promise.all([
      call(api.settings.get(), { silent: true }),
      call(api.books.list(), { silent: true }),
      call(api.fonts.list(), { silent: true }),
      call(api.progress.recent(), { silent: true }),
    ]);

    State.settings = settings || {};
    State.books = books || [];
    State.fonts = fonts || [];
    State.recent = recent || [];

    // 首次启动或设置缺失时，用主进程默认值补齐
    if (!State.settings || Object.keys(State.settings).length === 0) {
      State.settings = await call(api.settings.get(), { silent: true }) || {};
    }

    this.theme.settings = State.settings;
    this.theme.apply();

    // 视图初始化
    this.bookshelf = new BookshelfView({ state: State, bus: Bus, app: this });
    this.settingsView = new SettingsView({ state: State, bus: Bus, app: this });
    this.reader = new ReaderView({ state: State, bus: Bus, app: this });
    this.boss = new BossView({ state: State, bus: Bus, app: this });

    await this.bookshelf.init();
    await this.settingsView.init();
    await this.reader.init();
    await this.boss.init();

    this.renderTitlebar();
    this.route('library');

    // 启动后检查丢失的源文件
    this.checkMissing();

    // 异步加载字体列表（可能较慢，不阻塞首屏）
    this.refreshFontsInBackground();

    document.body.classList.add('is-ready');
    Bus.emit('app:ready');
  },

  /** 静态图标填充 */
  applyStaticIcons() {
    $('#btnMin').innerHTML = icon('minimize', 15);
    $('#btnMax').innerHTML = icon('maximize', 13);
    $('#btnClose').innerHTML = icon('close', 15);
    $('#shelfSearchIcon').innerHTML = icon('search', 15);
    $('#importIcon').innerHTML = icon('plus', 15);
    $('#btnViewMode').innerHTML = icon('rows', 16);
    $('#btnShelfMore').innerHTML = icon('more', 17);
    $('#navSettings').innerHTML = icon('settings', 17) + '<span class="sidebar__label">设置</span>';
    $('#navImportFont').innerHTML = icon('upload', 17) + '<span class="sidebar__label">导入字体</span>';
    $('#readerErrorIcon').innerHTML = icon('info', 56);
    $('#rbtnBack').innerHTML = icon('arrowLeft', 17);
    $('#rbtnBoss').innerHTML = icon('ghost', 17);
    $('#rbtnSearch').innerHTML = icon('search', 17);
    $('#rbtnBookmark').innerHTML = icon('bookmark', 17);
    $('#rbtnFullscreen').innerHTML = icon('fullscreen', 16);
    $('#rbtnMore').innerHTML = icon('type', 17);
    $('#tocClose').innerHTML = icon('x', 15);
    $('#tocSort').innerHTML = icon('scroll', 15);
    $('#searchClose').innerHTML = icon('x', 15);
    $('#bmClose').innerHTML = icon('x', 15);
    $('#rsClose').innerHTML = icon('x', 15);
  },

  /** 无边框窗口的自绘控制按钮 */
  bindWindowControls() {
    $('#btnMin').addEventListener('click', () => api.app.minimize());
    $('#btnMax').addEventListener('click', () => api.app.maximize());
    $('#btnClose').addEventListener('click', () => api.app.close());

    // 双击标题栏切换最大化
    const tb = $('#titlebar');
    let lastClick = 0;
    tb.addEventListener('click', (e) => {
      if (e.target.closest('button, input, .titlebar__center')) return;
      const now = Date.now();
      if (now - lastClick < 320) {
        api.app.maximize();
        lastClick = 0;
      } else {
        lastClick = now;
      }
    });

    api.app.onMaximizeChange((isMax) => {
      $('#btnMax').innerHTML = isMax ? icon('restore', 13) : icon('maximize', 13);
    });
    api.app.onFullScreenChange((v) => {
      $('#rbtnFullscreen').innerHTML = v ? icon('exitFullscreen', 16) : icon('fullscreen', 16);
    });
    api.app.isMaximized().then((r) => {
      if (r && r.ok && r.data) $('#btnMax').innerHTML = icon('restore', 13);
    });
  },

  /**
   * 全局快捷键。
   *
   * ⚠ 所有可自定义的键都通过 Keymap 查表（见 lib/keymap.js）：
   *   这里不再写死 'Ctrl+F' 这类字面量，改成 matches(e, keymap.resolve(action))。
   *   用户改键后立即生效，无需重启 —— 因为每次按键都会重新查表。
   *
   * 不开放自定义的键：
   *   · Esc —— 退出摸鱼/逐层返回，改坏了会"进得去出不来"
   *   · F11  —— 由下面单独处理，但也在快捷键表里可自定义（见 app.fullscreen）
   */
  bindGlobalKeys() {
    on(document, 'keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const inInput = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
      const km = this.keymap;

      // Esc 逐层退出（刻意不可自定义：这是"退出摸鱼"的兜底通道）
      if (e.key === 'Escape') {
        if (this.boss && this.boss.isActive) { this.boss.exit(); return; }
        if (this.reader && this.reader.handleEscape()) { e.preventDefault(); return; }
        if (State.view === 'settings') { this.route('library'); return; }
      }

      // 全屏：任何视图下都可触发
      if (km && matches(e, km.resolve('app.fullscreen'))) {
        e.preventDefault();
        e.stopPropagation();
        this.toggleFullscreen();
        return;
      }

      // 导入：全局生效
      if (km && matches(e, km.resolve('book.import'))) {
        e.preventDefault();
        if (State.view === 'reader') this.reader.close();
        this.bookshelf.importDialog();
        return;
      }

      // 以下为阅读页专属
      if (State.view !== 'reader') return;
      if (inInput) return;

      const R = (name) => km && matches(e, km.resolve(name));

      if (R('reader.search')) { e.preventDefault(); this.reader.openSearch(); return; }
      if (R('reader.bookmark')) { e.preventDefault(); this.reader.toggleBookmark(); return; }
      if (R('reader.settings')) { e.preventDefault(); this.reader.toggleSettings(); return; }
      if (R('reader.toc')) { e.preventDefault(); this.reader.toggleToc(); return; }
      if (R('reader.fontUp')) { e.preventDefault(); Bus.emit('reader:step-font', 1); return; }
      if (R('reader.fontDown')) { e.preventDefault(); Bus.emit('reader:step-font', -1); return; }
      if (R('reader.dark')) { e.preventDefault(); Bus.emit('reader:toggle-dark'); return; }
      if (R('reader.boss')) { e.preventDefault(); this.reader.openBossMenu(); return; }
    });
  },

  /** 主进程推送 */
  bindIpcEvents() {
    api.onBooksChanged(async () => {
      State.books = await call(api.books.list(), { silent: true }) || [];
      Bus.emit('books:changed');
    });

    api.onOpenFile(async (paths) => {
      const res = await call(api.books.import(paths));
      if (res) {
        await this.reloadBooks();
        toast.success(`已导入 ${res.success} 本`);
        if (res.results && res.results.length === 1 && res.results[0].ok) {
          this.bookshelf.openBook(res.results[0].book.id);
        }
      }
    });

    api.boss.onToggle((state) => {
      if (this.boss) this.boss.syncFromMain(state);
    });

    api.onNavigate?.((target) => {
      if (target === 'library') this.route('library');
    });

    // Ctrl+F 在阅读页时，若焦点在搜索框，交由浏览器处理
  },

  async reloadBooks() {
    State.books = await call(api.books.list(), { silent: true }) || [];
    State.recent = await call(api.progress.recent(), { silent: true }) || [];
    Bus.emit('books:changed');
  },

  async refreshFontsInBackground() {
    const fonts = await call(api.fonts.list(), { silent: true });
    if (fonts && fonts.length) {
      State.fonts = fonts;
      Bus.emit('fonts:changed');
    }
  },

  async checkMissing() {
    const missing = await call(api.books.validate(), { silent: true });
    State.missing = missing || [];
    if (State.missing.length) {
      Bus.emit('books:changed');
      toast.error(`${State.missing.length} 本书的源文件已失效，可在书架中查看`, { duration: 4000 });
    }
  },

  async toggleFullscreen() {
    if (State.view !== 'reader') {
      const cur = await api.app.isFullScreen();
      const now = cur && cur.ok ? cur.data : false;
      const r = await api.app.setFullScreen(!now);
      if (r && r.ok && r.data) toast('已进入全屏，按 F11 退出', { duration: 1600 });
      return;
    }
    const cur = await api.app.isFullScreen();
    const now = cur && cur.ok ? cur.data : false;
    await api.app.setFullScreen(!now);
  },

  /** 视图路由 */
  route(view) {
    const views = {
      library: $('#viewLibrary'),
      reader: $('#viewReader'),
      settings: $('#viewSettings'),
    };
    if (!views[view]) return;

    for (const [k, node] of Object.entries(views)) {
      node.classList.toggle('view--hidden', k !== view);
    }
    State.view = view;
    this.renderTitlebar();
    Bus.emit('route', view);
  },

  /** 标题栏内容随视图变化 */
  renderTitlebar() {
    const center = $('#titlebarCenter');
    const actions = $('#titlebarActions');
    const sub = $('#titlebarSub');

    // 防御：标题栏节点缺失时直接返回，避免整个路由流程被拖垮
    if (!center || !actions || !sub) return;

    clear(center);
    clear(actions);

    // 用事件委托绑定一次，避免每次渲染重复挂监听导致监听器泄漏
    if (!this._titlebarBound) {
      this._titlebarBound = true;
      center.addEventListener('click', (e) => {
        const b = e.target.closest('[data-nav]');
        if (b) this.route(b.dataset.nav);
      });
    }

    if (State.view === 'library') {
      sub.textContent = '';
      center.appendChild(el('div.segment', {}, [
        el('button.segment__item.is-active', { text: '书架', 'data-nav': 'library' }),
        el('button.segment__item', { text: '设置', 'data-nav': 'settings' }),
      ]));
    } else if (State.view === 'reader') {
      sub.textContent = '';
      const mode = State.settings.pageMode === 'scroll' ? '滚动' : '翻页';
      const themeDef = THEMES.find((t) => t.key === State.settings.theme);
      center.appendChild(el('div.flex.items-center.gap-2', {}, [
        el('span.text-sm.text-tertiary', { text: `${mode}模式 · ${themeDef ? themeDef.label : ''}` }),
      ]));
    } else if (State.view === 'settings') {
      sub.textContent = '';
      center.appendChild(el('div.segment', {}, [
        el('button.segment__item', { text: '书架', 'data-nav': 'library' }),
        el('button.segment__item.is-active', { text: '设置', 'data-nav': 'settings' }),
      ]));
    }
  },

  /** 保存设置（带节流，避免拖动滑块时刷爆 IPC） */
  saveSettings: null, // init 后赋值

  async patchSettings(patch, silent) {
    State.settings = { ...State.settings, ...patch };
    this.theme.settings = State.settings;
    this.theme.apply();
    // 快捷键表跟随设置：改键后立刻生效
    if (this.keymap) this.keymap.settings = State.settings;
    const res = await call(api.settings.patch(patch), { silent: silent !== false });
    if (res) {
      State.settings = res;
      if (this.keymap) this.keymap.settings = State.settings;
    }
    return State.settings;
  },
};

// 设置保存节流
App.saveSettings = debounce((patch) => {
  api.settings.patch(patch);
}, 320);

// 启动
window.addEventListener('DOMContentLoaded', () => {
  App.init().catch((err) => {
    console.error('[init]', err);
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#c00">
      <h2>苍穹启动失败</h2><pre style="white-space:pre-wrap">${esc(err && err.message ? err.message : String(err))}</pre>
    </div>`;
  });
});

// 暴露给主进程做自检用（冒烟测试 / 调试）
window.__APP__ = { App, State, Bus };

// 全局拖拽拦截：避免文件被浏览器直接打开
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', (e) => { e.preventDefault(); });

export { api, toast, call, icon, el, $, $$, clear, esc, fmtNum };