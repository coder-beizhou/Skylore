import { $, $$, el, clear, on, esc, fmtNum, fmtSize, fmtRelative, fmtDuration, debounce, delegate } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast, call } from '../lib/toast.js';

/**
 * 书架视图：网格封面墙 + 分组侧栏 + 导入 + 搜索排序 + 右键菜单。
 */
export class BookshelfView {
  constructor({ state, bus, app }) {
    this.state = state;
    this.bus = bus;
    this.app = app;
    this.api = window.firmament;
    this.dragDepth = 0;
    this.activeGroup = 'all';
    this.sort = 'recent';
  }

  async init() {
    this.renderSidebar();
    this.bindEvents();

    this.bus.on('books:changed', () => this.render());
    this.bus.on('route', (v) => { if (v === 'library') this.render(); });

    // 恢复上次的视图模式
    const mode = this.state.settings.shelfViewMode || 'grid';
    this.state.viewMode = mode;
    this.applyViewMode();

    this.render();
  }

  /* ============================ 侧栏 ============================ */

  renderSidebar() {
    const host = $('#sidebarItems');
    clear(host);

    const books = this.state.books;
    const progressMap = this.state.recent.reduce((m, r) => { m[r.book.id] = r.progress; return m; }, {});

    const total = books.length;
    const reading = books.filter((b) => progressMap[b.id] && (progressMap[b.id].ratio || 0) > 0.001 && (progressMap[b.id].ratio || 0) < 0.999).length;
    const finished = books.filter((b) => (progressMap[b.id] && progressMap[b.id].ratio >= 0.999)).length;
    const favCount = books.filter((b) => b.favorite).length;
    const missing = books.filter((b) => this.state.missing.some((m) => m.id === b.id)).length;

    const item = (key, label, count, iconName, extraClass) => {
      const node = el('button.sidebar__item', { class: extraClass || '', dataset: { group: key }, title: label }, [
        el('span', { html: icon(iconName, 17), style: { display: 'flex' } }),
        // 类名供窄窗适配使用：窗口很窄时只留图标，隐藏文字
        el('span.sidebar__label', { text: label }),
        count != null ? el('span.sidebar__count', { text: String(count) }) : null,
      ]);
      if (this.activeGroup === key) node.classList.add('is-active');
      node.addEventListener('click', () => {
        this.activeGroup = key;
        this.state.shelfFilter = { type: key, value: null, search: this.state.shelfFilter.search };
        this.render();
      });
      return node;
    };

    host.appendChild(el('div.sidebar__section', { text: '书库' }));
    host.appendChild(item('all', '全部书籍', total, 'library'));
    host.appendChild(item('reading', '在读', reading, 'book'));
    host.appendChild(item('finished', '已读完', finished, 'check'));
    host.appendChild(item('favorite', '收藏', favCount, 'heart'));

    // 分组列表
    const groups = [...new Set(books.map((b) => b.group).filter(Boolean))];
    if (groups.length) {
      host.appendChild(el('div.sidebar__section', { text: '分组' }));
      for (const g of groups) {
        const count = books.filter((b) => b.group === g).length;
        const node = el('button.sidebar__item.sidebar__item--drop', { dataset: { group: 'g:' + g }, title: g }, [
          el('span', { html: icon('folder', 17), style: { display: 'flex' } }),
          el('span.sidebar__label', { text: g }),
          el('span.sidebar__count', { text: String(count) }),
        ]);
        if (this.activeGroup === 'g:' + g) node.classList.add('is-active');
        node.addEventListener('click', () => {
          this.activeGroup = 'g:' + g;
          this.state.shelfFilter = { type: 'group', value: g, search: this.state.shelfFilter.search };
          this.render();
        });

        // 拖拽书籍到分组
        node.addEventListener('dragover', (e) => {
          if (!e.dataTransfer.types.includes('text/firmament-book')) return;
          e.preventDefault();
          node.classList.add('is-drop-target');
        });
        node.addEventListener('dragleave', () => node.classList.remove('is-drop-target'));
        node.addEventListener('drop', async (e) => {
          node.classList.remove('is-drop-target');
          const id = e.dataTransfer.getData('text/firmament-book');
          if (!id) return;
          e.preventDefault();
          e.stopPropagation();
          await call(this.api.books.update(id, { group: g }));
          await this.app.reloadBooks();
          toast.success(`已移动到「${g}」`);
        });

        host.appendChild(node);
      }
    }

    if (missing > 0) {
      host.appendChild(el('div.sidebar__section', { text: '异常' }));
      host.appendChild(item('missing', '文件失效', missing, 'info'));
    }
  }

  /* ============================ 主渲染 ============================ */

  getFilteredBooks() {
    let list = this.state.books.slice();
    const f = this.state.shelfFilter;

    const progressOf = (id) => {
      const r = this.state.recent.find((x) => x.book.id === id);
      return r ? r.progress : null;
    };

    if (f.type === 'reading') {
      list = list.filter((b) => {
        const p = progressOf(b.id);
        return p && (p.ratio || 0) > 0.001 && (p.ratio || 0) < 0.999;
      });
    } else if (f.type === 'finished') {
      list = list.filter((b) => {
        const p = progressOf(b.id);
        return p && (p.ratio || 0) >= 0.999;
      });
    } else if (f.type === 'favorite') {
      list = list.filter((b) => b.favorite);
    } else if (f.type === 'group') {
      list = list.filter((b) => b.group === f.value);
    } else if (f.type === 'missing') {
      const ids = new Set(this.state.missing.map((m) => m.id));
      list = list.filter((b) => ids.has(b.id));
    }

    if (f.search) {
      const q = f.search.toLowerCase();
      list = list.filter((b) =>
        b.title.toLowerCase().includes(q) ||
        (b.author || '').toLowerCase().includes(q) ||
        (b.group || '').toLowerCase().includes(q)
      );
    }

    return this.sortBooks(list);
  }

  sortBooks(list) {
    const progressOf = (id) => {
      const r = this.state.recent.find((x) => x.book.id === id);
      return r ? r.progress : null;
    };
    const arr = list.slice();
    switch (this.sort) {
      case 'title':
        arr.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
        break;
      case 'added':
        arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        break;
      case 'progress': {
        arr.sort((a, b) => {
          const pa = progressOf(a.id);
          const pb = progressOf(b.id);
          return ((pb && pb.ratio) || 0) - ((pa && pa.ratio) || 0);
        });
        break;
      }
      case 'manual':
        break;
      case 'recent':
      default: {
        arr.sort((a, b) => {
          const ta = Math.max(a.lastReadAt || 0, 0);
          const tb = Math.max(b.lastReadAt || 0, 0);
          if (ta !== tb) return tb - ta;
          return (b.addedAt || 0) - (a.addedAt || 0);
        });
        break;
      }
    }
    return arr;
  }

  render() {
    this.renderSidebar();
    this.renderHead();
    this.renderResume();
    this.renderStats();
    this.renderGrid();
    this.renderSortSegment();
  }

  renderHead() {
    const map = {
      all: ['全部书籍', ''],
      reading: ['在读', ''],
      finished: ['已读完', ''],
      favorite: ['收藏', ''],
      missing: ['文件失效', '这些书的源文件已被移动或删除'],
      group: [this.state.shelfFilter.value || '分组', ''],
    };
    const [title, hint] = map[this.state.shelfFilter.type] || ['全部书籍', ''];
    $('#shelfTitle').textContent = title;
    const list = this.getFilteredBooks();
    const meta = $('#shelfMeta');
    meta.textContent = list.length ? `${list.length} 本${hint ? ' · ' + hint : ''}` : hint;
  }

  renderSortSegment() {
    $$('#shelfSort .segment__item').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.sort === this.sort);
    });
  }

  /** 继续阅读卡片 */
  renderResume() {
    const host = $('#resumeHost');
    clear(host);
    if (this.state.shelfFilter.type !== 'all' || this.state.shelfFilter.search) return;

    const items = this.state.recent.filter((r) => {
      const p = r.progress;
      return p && (p.ratio || 0) > 0.002 && (p.ratio || 0) < 0.995;
    });
    if (!items.length) return;

    const r = items[0];
    const b = r.book;
    const p = r.progress;
    const pct = Math.round((p.ratio || 0) * 100);

    const card = el('div.resume-card', { role: 'button', tabindex: '0' }, [
      el('div.resume-card__cover', {}, el('img', { src: b.cover, alt: '', loading: 'lazy' })),
      el('div.resume-card__body', {}, [
        el('div.resume-card__label', { text: '继续阅读' }),
        el('div.resume-card__title', { text: b.title }),
        el('div.resume-card__chapter', {
          text: [p.chapterTitle, p.pageCount ? `第 ${(p.pageIndex || 0) + 1}/${p.pageCount} 页` : null]
            .filter(Boolean).join(' · ') || `第 ${(p.chapterIndex || 0) + 1} 章`,
        }),
      ]),
      el('div.resume-card__bar', {}, [
        el('span.text-sm.text-secondary', { text: `${pct}%` }),
        el('div.progress-track', {}, el('div.progress-fill', { style: { width: pct + '%' } })),
        el('span.text-xs.text-tertiary', { text: fmtRelative(p.updatedAt) }),
      ]),
    ]);

    card.addEventListener('click', () => this.openBook(b.id, { resume: true }));
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') card.click(); });
    host.appendChild(card);
  }

  /** 阅读统计条 */
  renderStats() {
    const host = $('#statHost');
    clear(host);
    if (this.state.shelfFilter.type !== 'all' || this.state.shelfFilter.search) return;
    if (!this.state.books.length) return;

    const books = this.state.books;
    const totalChars = books.reduce((a, b) => a + (b.charCount || 0), 0);
    const totalSec = this.state.recent.reduce((a, r) => a + (r.progress.readSeconds || 0), 0);
    const finishedCount = books.filter((b) => {
      const r = this.state.recent.find((x) => x.book.id === b.id);
      return r && (r.progress.ratio || 0) >= 0.999;
    }).length;

    host.appendChild(el('div.stat-strip', {}, [
      el('div.stat-chip', {}, [
        el('span', { html: icon('book', 14), style: { display: 'flex' } }),
        el('span', { text: '藏书 ' }),
        el('strong', { text: String(books.length) }),
        el('span', { text: ' 本' }),
      ]),
      el('div.stat-chip', {}, [
        el('span', { text: '总字数 ' }),
        el('strong', { text: fmtNum(totalChars) }),
      ]),
      el('div.stat-chip', {}, [
        el('span', { html: icon('clock', 14), style: { display: 'flex' } }),
        el('span', { text: '累计阅读 ' }),
        el('strong', { text: fmtDuration(totalSec) }),
      ]),
      finishedCount > 0 ? el('div.stat-chip', {}, [
        el('span', { text: '已读完 ' }),
        el('strong', { text: String(finishedCount) }),
        el('span', { text: ' 本' }),
      ]) : null,
    ]));
  }

  renderGrid() {
    const body = $('#shelfBody');
    if (!body) return;

    // ⚠ 网格节点必须"保命"。
    //   不能对 body 直接 clear() —— 那会把 #shelfGrid 一起删掉，
    //   于是「空书架 → 导入第一本书」时 grid 变成 null，书架直接崩。
    //   正确做法：先确保 grid 存在且在 body 内，再只清它；空态用独立容器承载。
    let grid = $('#shelfGrid');
    if (!grid) {
      grid = el('div.grid#shelfGrid');
      body.appendChild(grid);
    }

    // 清掉上一次的空态容器（若有），并把 grid 放回 body
    const staleEmpty = body.querySelector('.empty-host');
    if (staleEmpty) staleEmpty.remove();
    if (!body.contains(grid)) body.appendChild(grid);

    clear(grid);

    const list = this.getFilteredBooks();
    grid.classList.toggle('grid--list', this.state.viewMode === 'list');

    if (!list.length) {
      grid.style.display = 'none';
      body.appendChild(el('div.empty-host', {}, this.emptyState()));
      return;
    }
    grid.style.display = '';

    const progressOf = (id) => {
      const r = this.state.recent.find((x) => x.book.id === id);
      return r ? r.progress : null;
    };
    const missingIds = new Set(this.state.missing.map((m) => m.id));

    list.forEach((b, i) => {
      const p = progressOf(b.id);
      const pct = p ? Math.round((p.ratio || 0) * 100) : 0;
      const isMissing = missingIds.has(b.id);

      const card = el('div.library-card', {
        dataset: { id: b.id },
        draggable: 'true',
        title: `${b.title}\n${b.author}\n${b.format.toUpperCase()} · ${fmtNum(b.charCount)} 字 · ${b.chapterCount} 章`,
        style: { animationDelay: Math.min(i * 22, 400) + 'ms' },
      }, [
        el('div.library-card__cover', {}, [
          el('img', { src: b.cover, alt: b.title, loading: 'lazy', draggable: 'false' }),
          el('span.library-card__badge', {
            class: `library-card__badge--${b.format}`,
            text: b.format.toUpperCase(),
          }),
          el('button.library-card__fav', {
            class: b.favorite ? 'is-on' : '',
            title: b.favorite ? '取消收藏' : '收藏',
            html: icon('heart', 14),
            'data-fav': b.id,
          }),
          pct > 0 ? el('div.library-card__progress', {}, el('div.library-card__progress-bar', { style: { width: pct + '%' } })) : null,
        ]),
        el('div.library-card__hover', {}, [
          el('span', { html: icon('play', 34), style: { color: '#fff', opacity: '0.95', display: 'flex' } }),
        ]),
        el('div.library-card__info', {}, [
          el('div.library-card__title', { text: b.title }),
          el('div.library-card__author', { text: b.author || '佚名' }),
          el('div.library-card__stat', {}, [
            el('span', { text: `${b.chapterCount} 章` }),
            el('span', { text: '·' }),
            pct > 0 ? el('span', { text: `已读 ${pct}%` }) : el('span', { text: fmtSize(b.size) }),
          ]),
        ]),
      ]);

      if (isMissing) card.classList.add('is-missing');

      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-fav]')) return;
        if (isMissing) {
          this.showMissingDialog(b);
          return;
        }
        this.openBook(b.id);
      });

      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.showContextMenu(e.clientX, e.clientY, b, isMissing);
      });

      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/firmament-book', b.id);
        e.dataTransfer.effectAllowed = 'move';
        card.style.opacity = '0.4';
      });
      card.addEventListener('dragend', () => { card.style.opacity = ''; });

      grid.appendChild(card);
    });
  }

  emptyState() {
    const isEmptyLib = !this.state.books.length;
    const wrap = el('div.empty');

    const art = el('div.empty__art', { html: isEmptyLib
      ? `<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <rect x="14" y="20" width="26" height="56" rx="3"/>
           <rect x="44" y="20" width="26" height="56" rx="3"/>
           <path d="M40 26l22-6 14 52-22 6z" fill="none"/>
           <path d="M30 88h44"/>
         </svg>`
      : `<svg viewBox="0 0 96 96" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
           <circle cx="44" cy="44" r="26"/>
           <path d="M63 63l16 16"/>
         </svg>` });

    wrap.appendChild(art);

    if (isEmptyLib) {
      wrap.appendChild(el('div.empty__title', { text: '书架还是空的' }));
      wrap.appendChild(el('div.empty__desc', {
        text: '把 TXT 或 EPUB 小说拖到这里，或点击下方按钮导入。也支持扫描整个文件夹批量导入。',
      }));
      wrap.appendChild(el('div.flex.gap-2', {}, [
        el('button.btn.btn--solid.btn--lg', {
          html: icon('plus', 16) + '<span>选择文件导入</span>',
          onclick: () => this.importDialog(),
        }),
        el('button.btn.btn--ghost.btn--lg', {
          html: icon('folder', 16) + '<span>扫描文件夹</span>',
          onclick: () => this.importFolderDialog(),
        }),
      ]));
    } else {
      wrap.appendChild(el('div.empty__title', { text: '没有符合条件的书' }));
      wrap.appendChild(el('div.empty__desc', { text: '换个筛选条件或清空搜索关键词试试。' }));
      const btn = el('button.btn.btn--ghost', { text: '查看全部书籍' });
      btn.addEventListener('click', () => {
        this.activeGroup = 'all';
        this.state.shelfFilter = { type: 'all', value: null, search: '' };
        $('#shelfSearch').value = '';
        this.render();
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }

  /* ============================ 交互 ============================ */

  bindEvents() {
    // 搜索
    const searchInput = $('#shelfSearch');
    searchInput.addEventListener('input', debounce((e) => {
      this.state.shelfFilter = { ...this.state.shelfFilter, search: e.target.value.trim() };
      this.renderGrid();
      this.renderHead();
    }, 180));
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { searchInput.value = ''; searchInput.blur(); }
    });

    // 排序
    delegate($('#shelfSort'), '.segment__item', 'click', (e, b) => {
      this.sort = b.dataset.sort;
      this.renderGrid();
      this.renderSortSegment();
    });

    // 视图模式
    $('#btnViewMode').addEventListener('click', () => {
      this.state.viewMode = this.state.viewMode === 'grid' ? 'list' : 'grid';
      this.applyViewMode();
      this.renderGrid();
      this.app.patchSettings({ shelfViewMode: this.state.viewMode });
    });

    // 导入
    $('#btnImport').addEventListener('click', () => this.importDialog());

    // 更多菜单
    $('#btnShelfMore').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      this.showShelfMenu(r.left, r.bottom + 6);
    });

    // 导航
    $('#navSettings').addEventListener('click', () => this.app.route('settings'));
    $('#navImportFont').addEventListener('click', () => this.app.settingsView.importFonts());

    // 拖拽导入
    this.bindDropImport();

    // 收藏按钮委托
    delegate($('#shelfGrid'), '[data-fav]', 'click', async (e, btn) => {
      e.stopPropagation();
      const id = btn.dataset.fav;
      const book = this.state.books.find((b) => b.id === id);
      if (!book) return;
      const next = !book.favorite;
      btn.classList.toggle('is-on', next);
      await call(this.api.books.update(id, { favorite: next }));
      book.favorite = next;
      toast(next ? '已加入收藏' : '已取消收藏');
      this.renderSidebar();
    });

    // 点击空白关闭右键菜单
    on(document, 'click', () => this.closeContextMenu());
    on(document, 'contextmenu', (e) => {
      if (!e.target.closest('.library-card')) this.closeContextMenu();
    });
    on(window, 'blur', () => this.closeContextMenu());
    on(document, 'scroll', () => this.closeContextMenu(), true);
  }

  applyViewMode() {
    const btn = $('#btnViewMode');
    btn.innerHTML = this.state.viewMode === 'grid' ? icon('rows', 16) : icon('grid', 16);
    btn.title = this.state.viewMode === 'grid' ? '切换到列表视图' : '切换到网格视图';
  }

  /** 拖拽文件到窗口导入 */
  bindDropImport() {
    const mask = el('div.drop-mask.hidden', {}, [
      el('div.drop-mask__inner', {}, [
        el('span', { html: icon('upload', 40), style: { display: 'flex' } }),
        el('strong', { text: '松手即可导入' }),
        el('span', { text: '支持 TXT、EPUB，可一次拖入多个文件或文件夹' }),
      ]),
    ]);
    $('#viewLibrary').appendChild(mask);

    on(window, 'dragenter', (e) => {
      if (this.state.view !== 'library') return;
      if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
      this.dragDepth++;
      mask.classList.remove('hidden');
    });

    on(window, 'dragover', (e) => {
      if (this.state.view !== 'library') return;
      if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    on(window, 'dragleave', (e) => {
      if (this.state.view !== 'library') return;
      this.dragDepth = Math.max(0, this.dragDepth - 1);
      if (this.dragDepth === 0) mask.classList.add('hidden');
    });

    on(window, 'drop', async (e) => {
      if (this.state.view !== 'library') return;
      if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      this.dragDepth = 0;
      mask.classList.add('hidden');

      const files = Array.from(e.dataTransfer.files || []);
      if (!files.length) return;

      const paths = [];
      const folders = [];
      for (const f of files) {
        const p = f.path || (window.firmament && f.path);
        if (!p) continue;
        if (/\.(txt|text|epub)$/i.test(p)) paths.push(p);
        else if (!/\./.test(f.name)) folders.push(p);
      }

      // 文件夹递归扫描
      for (const dir of folders) {
        const found = await call(this.api.books.scanFolder(dir), { silent: true });
        if (found && found.length) paths.push(...found);
      }

      if (!paths.length) {
        toast.error('没有发现可导入的 TXT / EPUB 文件');
        return;
      }
      await this.doImport(paths);
    });
  }

  async importDialog() {
    const res = await call(this.api.books.importDialog());
    if (!res || res.canceled) return;
    this.reportImport(res);
  }

  async importFolderDialog() {
    const res = await call(this.api.books.importFolderDialog());
    if (!res || res.canceled) return;
    if (res.empty) {
      toast.error('该文件夹内没有找到 TXT / EPUB 文件');
      return;
    }
    this.reportImport(res);
  }

  async doImport(paths) {
    const res = await call(this.api.books.import(paths));
    if (!res) return;
    this.reportImport(res);
  }

  async reportImport(res) {
    await this.app.reloadBooks();

    const { success = 0, failed = 0, duplicates = 0, results = [] } = res;
    const fresh = success - duplicates;

    if (success === 0 && failed > 0) {
      const first = results.find((r) => !r.ok);
      toast.error(`导入失败：${first ? first.error : '未知原因'}`, { duration: 4200 });
      return;
    }

    const parts = [];
    if (fresh > 0) parts.push(`成功导入 ${fresh} 本`);
    if (duplicates > 0) parts.push(`${duplicates} 本已存在`);
    if (failed > 0) parts.push(`${failed} 本失败`);
    if (parts.length) toast.success(parts.join('，'));

    if (failed > 0) {
      const failedList = results.filter((r) => !r.ok);
      const detail = failedList.slice(0, 6).map((r) => `· ${r.path.split(/[\\/]/).pop()}：${r.error}`).join('\n');
      await call(this.api.dialog.message({
        type: 'warning',
        title: '部分文件未能导入',
        message: `${failed} 个文件导入失败`,
        detail: detail + (failedList.length > 6 ? `\n… 另有 ${failedList.length - 6} 个` : ''),
        buttons: ['知道了'],
      }), { silent: true });
    }
  }

  /** 打开一本书 */
  openBook(id, opts) {
    this.app.reader.open(id, opts);
  }

  /* ============================ 右键菜单 ============================ */

  showContextMenu(x, y, book, isMissing) {
    this.closeContextMenu();
    const host = $('#ctxMenuHost');

    const item = (label, iconName, fn, danger) => {
      const node = el('button.context-menu__item', { class: danger ? 'context-menu__item--danger' : '' }, [
        el('span', { html: icon(iconName, 15), style: { display: 'flex' } }),
        el('span', { text: label }),
      ]);
      node.addEventListener('click', () => { this.closeContextMenu(); fn(); });
      return node;
    };

    const menu = el('div.context-menu', {}, [
      item('开始阅读', 'book', () => this.openBook(book.id)),
      item(book.favorite ? '取消收藏' : '加入收藏', 'heart', async () => {
        await call(this.api.books.update(book.id, { favorite: !book.favorite }));
        await this.app.reloadBooks();
      }),
      el('div.context-menu__divider'),
      item('重命名 / 改作者', 'pencil', () => this.showEditDialog(book)),
      item('移动到分组', 'folder', () => this.showGroupDialog(book)),
      item('查看所在文件夹', 'file', () => call(this.api.books.revealInFolder(book.id), { silent: true })),
      el('div.context-menu__divider'),
      item('清除阅读进度', 'refresh', async () => {
        const ok = await call(this.api.dialog.confirm({
          title: '清除阅读进度',
          message: `确定要清除《${book.title}》的阅读进度吗？`,
          detail: '此操作不可撤销，但不会删除书籍文件。',
          buttons: ['取消', '清除'],
        }), { silent: true });
        if (ok) {
          await call(this.api.progress.clear(book.id));
          await this.app.reloadBooks();
          toast.success('已清除阅读进度');
        }
      }),
      item('从书架移除', 'trash', async () => {
        const ok = await call(this.api.dialog.confirm({
          title: '从书架移除',
          message: `确定要把《${book.title}》移出书架吗？`,
          detail: '仅从书架移除记录，不会删除你的原始文件。',
          buttons: ['取消', '移除'],
        }), { silent: true });
        if (ok) {
          await call(this.api.books.remove(book.id, false));
          await this.app.reloadBooks();
          toast.success('已移出书架');
        }
      }, true),
    ]);

    host.appendChild(menu);

    // 边界收敛
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    menu.style.left = Math.min(x, vw - rect.width - 8) + 'px';
    menu.style.top = Math.min(y, vh - rect.height - 8) + 'px';
  }

  closeContextMenu() {
    clear($('#ctxMenuHost'));
  }

  showShelfMenu(x, y) {
    this.closeContextMenu();
    const host = $('#ctxMenuHost');

    const item = (label, iconName, fn) => {
      const node = el('button.context-menu__item', {}, [
        el('span', { html: icon(iconName, 15), style: { display: 'flex' } }),
        el('span', { text: label }),
      ]);
      node.addEventListener('click', () => { this.closeContextMenu(); fn(); });
      return node;
    };

    const menu = el('div.context-menu', {}, [
      item('导入文件', 'plus', () => this.importDialog()),
      item('扫描文件夹', 'folder', () => this.importFolderDialog()),
      el('div.context-menu__divider'),
      item('导入字体', 'upload', () => this.app.settingsView.importFonts()),
      item('打开数据目录', 'file', () => call(this.api.shell.openPath(this.state.settings.__dataDir || ''), { silent: true })),
      el('div.context-menu__divider'),
      item('检查文件有效性', 'shield', async () => {
        const missing = await call(this.api.books.validate());
        await this.app.reloadBooks();
        if (!missing || !missing.length) toast.success('所有书籍文件均正常');
        else toast.error(`${missing.length} 本书的源文件已失效`);
      }),
      item('重建自动封面', 'refresh', async () => {
        const r = await call(this.api.books.regenerateCovers(true));
        await this.app.reloadBooks();
        if (r) toast.success(r.updated > 0 ? `已重建 ${r.updated} 本封面` : '没有需要重建的封面');
      }),
      item('重新解析全部书籍', 'book', async () => {
        const list = this.state.books.slice();
        let ok = 0; let failed = 0;
        for (const b of list) {
          const r = await call(this.api.books.reload(b.id), { silent: true });
          if (r) ok++; else failed++;
        }
        await this.app.reloadBooks();
        toast.success(`重新解析完成：成功 ${ok}${failed ? `，失败 ${failed}` : ''}`);
      }),
      item('设置', 'settings', () => this.app.route('settings')),
    ]);

    host.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  }

  /* ============================ 小对话框 ============================ */

  showMissingDialog(book) {
    call(this.api.dialog.message({
      type: 'warning',
      title: '源文件失效',
      message: `《${book.title}》的源文件已无法访问`,
      detail: `原路径：\n${book.path}\n\n文件可能被移动、重命名或删除了。你可以从书架移除它，或者把文件放回原位置后再试。`,
      buttons: ['知道了'],
    }), { silent: true });
  }

  showEditDialog(book) {
    const host = $('#modalHost');
    const titleInput = el('input.input', { value: book.title, placeholder: '书名' });
    const authorInput = el('input.input', { value: book.author || '', placeholder: '作者' });

    const modal = el('div.modal', {}, [
      el('div.modal__head', {}, [
        el('div', {}, [
          el('h2.modal__title', { text: '编辑书籍信息' }),
          el('p.modal__desc', { text: '修改后仅影响书架显示，不会改动原始文件' }),
        ]),
      ]),
      el('div.modal__body', {}, [
        el('div.field', { style: { marginBottom: '16px' } }, [
          el('label.field__label', {}, el('span', { text: '书名' })),
          titleInput,
        ]),
        el('div.field', {}, [
          el('label.field__label', {}, el('span', { text: '作者' })),
          authorInput,
        ]),
      ]),
      el('div.modal__foot', {}, [
        (() => { const b = el('button.btn.btn--ghost', { text: '取消' }); b.addEventListener('click', close); return b; })(),
        (() => {
          const b = el('button.btn.btn--solid', { text: '保存' });
          b.addEventListener('click', async () => {
            const title = titleInput.value.trim();
            if (!title) { toast.error('书名不能为空'); return; }
            await call(this.api.books.update(book.id, { title, author: authorInput.value.trim() || '佚名' }));
            await this.app.reloadBooks();
            toast.success('已保存');
            close();
          });
          return b;
        })(),
      ]),
    ]);

    const overlay = el('div.overlay', {}, modal);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    host.appendChild(overlay);
    setTimeout(() => titleInput.focus(), 60);

    function close() { overlay.remove(); }
    on(document, 'keydown', function escHandler(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); }
      if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        modal.querySelector('.btn--solid').click();
      }
    });
  }

  showGroupDialog(book) {
    const host = $('#modalHost');
    const groups = [...new Set(this.state.books.map((b) => b.group).filter(Boolean))];
    const input = el('input.input', { value: book.group || '默认分组', placeholder: '输入或选择分组名' });

    const chips = el('div.flex.gap-2', { style: { flexWrap: 'wrap', marginTop: '10px' } });
    ['默认分组', ...groups.filter((g) => g !== '默认分组')].forEach((g) => {
      const c = el('button.btn.btn--ghost.btn--sm', { text: g });
      c.addEventListener('click', () => { input.value = g; });
      chips.appendChild(c);
    });

    const modal = el('div.modal', { style: { width: 'min(460px, 90vw)' } }, [
      el('div.modal__head', {}, el('h2.modal__title', { text: '移动到分组' })),
      el('div.modal__body', {}, [
        el('div.field', {}, [
          el('label.field__label', {}, el('span', { text: '分组名称' })),
          input,
          chips,
        ]),
      ]),
      el('div.modal__foot', {}, [
        (() => { const b = el('button.btn.btn--ghost', { text: '取消' }); b.addEventListener('click', close); return b; })(),
        (() => {
          const b = el('button.btn.btn--solid', { text: '确定' });
          b.addEventListener('click', async () => {
            const g = input.value.trim() || '默认分组';
            await call(this.api.books.update(book.id, { group: g }));
            await this.app.reloadBooks();
            toast.success(`已移动到「${g}」`);
            close();
          });
          return b;
        })(),
      ]),
    ]);

    const overlay = el('div.overlay', {}, modal);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    host.appendChild(overlay);
    setTimeout(() => input.select(), 60);

    function close() { overlay.remove(); }
    on(document, 'keydown', function escHandler(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); }
    });
  }
}