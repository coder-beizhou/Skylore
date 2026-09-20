'use strict';

const { ipcMain, dialog, shell, BrowserWindow } = require('electron');
const path = require('path');
const { MIN_W, MIN_H } = require('./boss');

/**
 * 注册全部 IPC。每个 handler 统一包一层错误处理，
 * 保证渲染层拿到的永远是 { ok, data } 或 { ok:false, error }，不会抛裸异常。
 */
function registerIpc(ctx) {
  const { library, store, fontsService, boss, app, dirs } = ctx;

  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        const data = await fn(...args);
        return { ok: true, data };
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (ctx.isDev) console.error(`[ipc:${channel}]`, err);
        return { ok: false, error: message };
      }
    });
  };

  const getWin = () => BrowserWindow.getAllWindows()[0] || null;

  // ——— 应用与窗口 ———
  handle('app:info', () => ({
    name: '苍穹',
    enName: 'Firmament Reader',
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    userData: dirs.dataDir,
    isDev: !!ctx.isDev,
  }));

  handle('app:open-devtools', () => {
    const w = getWin();
    if (w) w.webContents.toggleDevTools();
    return true;
  });

  handle('win:minimize', () => { const w = getWin(); if (w) w.minimize(); return true; });
  handle('win:maximize', () => {
    const w = getWin();
    if (!w) return false;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return w.isMaximized();
  });
  handle('win:close', () => { const w = getWin(); if (w) w.close(); return true; });
  handle('win:is-maximized', () => { const w = getWin(); return w ? w.isMaximized() : false; });
  handle('win:set-fullscreen', (v) => {
    const w = getWin();
    if (!w) return false;
    w.setFullScreen(!!v);
    return w.isFullScreen();
  });
  handle('win:is-fullscreen', () => { const w = getWin(); return w ? w.isFullScreen() : false; });
  handle('win:set-always-on-top', (v) => {
    const w = getWin();
    if (!w) return false;
    w.setAlwaysOnTop(!!v);
    return w.isAlwaysOnTop();
  });
  handle('win:set-opacity', (v) => {
    const w = getWin();
    if (!w) return false;
    const val = Math.max(0.08, Math.min(1, Number(v) || 1));
    w.setOpacity(val);
    return val;
  });

  /** 迷你框自定义拖拽：按鼠标位移移动窗口（替代 CSS 拖拽区） */
  handle('win:move-by', (dx, dy) => {
    const w = getWin();
    if (!w) return false;
    if (w.isMaximized() || w.isFullScreen()) return false;
    return ctx.boss.moveBy(dx, dy);
  });

  /** 当前窗口几何 + 最小尺寸限制（窄窗适配与测试用） */
  handle('win:bounds', () => {
    const w = getWin();
    if (!w) return null;
    const b = w.getBounds();
    return { ...b, minWidth: MIN_W, minHeight: MIN_H };
  });

  handle('win:set-size', (width, height) => {
    const w = getWin();
    if (!w || w.isMaximized()) return false;
    const b = w.getBounds();
    const nw = Math.max(420, Math.round(Number(width) || b.width));
    const nh = Math.max(400, Math.round(Number(height) || b.height));
    w.setBounds({ x: b.x, y: b.y, width: nw, height: nh }, false);
    return w.getBounds();
  });

  // ——— 书籍 ———
  handle('books:list', () => library.getBooks());

  handle('books:import', (paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    return library.importFiles(list);
  });

  handle('books:import-dialog', async () => {
    const w = getWin();
    const res = await dialog.showOpenDialog(w, {
      title: '导入小说',
      buttonLabel: '导入',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '小说文件', extensions: ['txt', 'epub', 'text'] },
        { name: 'TXT 文本', extensions: ['txt', 'text'] },
        { name: 'EPUB 电子书', extensions: ['epub'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true, total: 0, success: 0, failed: 0, results: [] };
    const out = await library.importFiles(res.filePaths);
    return { canceled: false, ...out };
  });

  handle('books:import-folder-dialog', async () => {
    const w = getWin();
    const res = await dialog.showOpenDialog(w, {
      title: '扫描文件夹',
      buttonLabel: '扫描导入',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true, total: 0, success: 0, failed: 0, results: [] };
    const files = library.scanFolder(res.filePaths[0], 4);
    if (!files.length) return { canceled: false, total: 0, success: 0, failed: 0, results: [], empty: true };
    const out = await library.importFiles(files);
    return { canceled: false, ...out };
  });

  handle('books:scan-folder', (dir) => library.scanFolder(dir, 4));
  handle('books:remove', (id, deleteFile) => library.removeBook(id, deleteFile));
  handle('books:update', (id, patch) => library.updateBook(id, patch));
  handle('books:toc', (id) => library.getToc(id));
  handle('books:chapter', (id, index) => library.getChapter(id, index));
  handle('books:search', (bookId, keyword, scope) => library.search(bookId, keyword, scope));
  handle('books:validate', () => library.validateBooks());
  handle('books:regenerate-covers', (force) => library.regenerateCovers({ force: !!force }));
  handle('books:reload', (id) => library.reloadBook(id));
  handle('books:reveal', (id) => {
    const b = library.findBook(id);
    if (!b) throw new Error('书籍不存在');
    shell.showItemInFolder(b.path);
    return true;
  });

  // ——— 设置 ———
  handle('settings:get', () => store.get('settings'));
  handle('settings:patch', (patch) => store.patchSettings(patch || {}));
  handle('settings:reset', (scope) => {
    if (scope === 'all') {
      store.update((d) => {
        d.settings = JSON.parse(JSON.stringify(store.defaults.settings));
      });
    }
    return store.get('settings');
  });

  // ——— 字体 ———
  handle('fonts:list', () => fontsService.getFontList(dirs.fontDir));
  handle('fonts:refresh', () => fontsService.getFontList(dirs.fontDir));
  handle('fonts:import-dialog', async () => {
    const w = getWin();
    const res = await dialog.showOpenDialog(w, {
      title: '导入字体',
      buttonLabel: '导入',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '字体文件', extensions: ['ttf', 'otf', 'ttc', 'woff', 'woff2'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true, imported: [] };
    const imported = [];
    const failed = [];
    for (const p of res.filePaths) {
      try {
        const name = fontsService.importUserFont(dirs.fontDir, p);
        imported.push(name);
      } catch (err) {
        failed.push({ path: p, error: err.message });
      }
    }
    const list = await fontsService.getFontList(dirs.fontDir);
    return { canceled: false, imported, failed, list };
  });

  handle('fonts:import', async (paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    const imported = [];
    const failed = [];
    for (const p of list) {
      try {
        imported.push(fontsService.importUserFont(dirs.fontDir, p));
      } catch (err) {
        failed.push({ path: p, error: err.message });
      }
    }
    return { imported, failed, list: await fontsService.getFontList(dirs.fontDir) };
  });

  handle('fonts:remove', async (file) => {
    const target = path.join(dirs.fontDir, path.basename(String(file)));
    if (!target.startsWith(dirs.fontDir)) throw new Error('非法路径');
    if (require('fs').existsSync(target)) require('fs').unlinkSync(target);
    return { list: await fontsService.getFontList(dirs.fontDir) };
  });

  handle('fonts:open-folder', async () => {
    if (!require('fs').existsSync(dirs.fontDir)) require('fs').mkdirSync(dirs.fontDir, { recursive: true });
    await shell.openPath(dirs.fontDir);
    return true;
  });

  // ——— 进度 ———
  handle('progress:get', (bookId) => {
    const d = store.get('progress');
    return (bookId ? d[bookId] : d) || null;
  });

  handle('progress:set', (bookId, data) => {
    if (!bookId) throw new Error('缺少书籍 id');
    return store.update((d) => {
      const prev = d.progress[bookId] || {};
      d.progress[bookId] = {
        ...prev,
        ...data,
        updatedAt: Date.now(),
        // 累计阅读时长
        readSeconds: (prev.readSeconds || 0) + (data.sessionSeconds || 0),
        sessionSeconds: 0,
      };
      const b = d.books.find((x) => x.id === bookId);
      if (b) b.lastReadAt = Date.now();
      return d.progress[bookId];
    });
  });

  handle('progress:recent', () => {
    const d = store.get('progress');
    const books = store.get('books');
    return books
      .filter((b) => d[b.id])
      .map((b) => ({ book: b, progress: d[b.id] }))
      .sort((a, b) => (b.progress.updatedAt || 0) - (a.progress.updatedAt || 0))
      .slice(0, 12);
  });

  handle('progress:clear', (bookId) => store.update((d) => {
    delete d.progress[bookId];
    return true;
  }));

  // ——— 书签 ———
  handle('bookmarks:list', (bookId) => {
    const d = store.get('bookmarks');
    return (bookId ? d[bookId] : d) || (bookId ? [] : {});
  });

  handle('bookmarks:add', (bookId, data) => store.update((d) => {
    if (!d.bookmarks[bookId]) d.bookmarks[bookId] = [];
    const item = {
      id: 'bm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      createdAt: Date.now(),
      ...data,
    };
    // 同章节同位置去重
    const dup = d.bookmarks[bookId].find((b) => b.chapterIndex === item.chapterIndex && Math.abs((b.percent || 0) - (item.percent || 0)) < 0.005);
    if (dup) return dup;
    d.bookmarks[bookId].unshift(item);
    return item;
  }));

  handle('bookmarks:remove', (bookId, id) => store.update((d) => {
    if (d.bookmarks[bookId]) d.bookmarks[bookId] = d.bookmarks[bookId].filter((b) => b.id !== id);
    return true;
  }));

  // ——— 摸鱼模式 ———
  handle('boss:toggle', (on) => boss.toggle(on));
  handle('boss:state', () => boss.getState());
  handle('boss:set-hotkey', (accel) => boss.setHotkey(accel));
  handle('boss:apply', (opts) => boss.applyOptions(opts));
  handle('boss:preview', (mode) => boss.preview(mode));

  // ——— 对话框 ———
  handle('dialog:message', async (opts) => {
    const w = getWin();
    const res = await dialog.showMessageBox(w, {
      type: opts.type || 'info',
      title: opts.title || '苍穹',
      message: opts.message || '',
      detail: opts.detail || '',
      buttons: opts.buttons || ['知道了'],
      defaultId: 0,
      noLink: true,
    });
    return res.response;
  });

  handle('dialog:confirm', async (opts) => {
    const w = getWin();
    const res = await dialog.showMessageBox(w, {
      type: opts.type || 'question',
      title: opts.title || '苍穹',
      message: opts.message || '',
      detail: opts.detail || '',
      buttons: opts.buttons || ['取消', '确定'],
      defaultId: opts.defaultId === undefined ? 1 : opts.defaultId,
      cancelId: opts.cancelId === undefined ? 0 : opts.cancelId,
      noLink: true,
    });
    return res.response === (opts.defaultId === undefined ? 1 : opts.defaultId);
  });

  // ——— 系统 ———
  handle('shell:open-path', async (p) => { await shell.openPath(String(p)); return true; });
  handle('shell:open-external', async (url) => {
    if (!/^https?:\/\//i.test(String(url))) throw new Error('仅允许打开 http/https 链接');
    await shell.openExternal(String(url));
    return true;
  });

  return { handle };
}

module.exports = { registerIpc };