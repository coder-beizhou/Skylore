'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 渲染层唯一的安全通道。contextIsolation 开启，渲染层拿不到 Node 能力，
 * 只能调用这里显式暴露的白名单方法。
 */

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

/** 订阅主进程推送，返回取消订阅函数 */
function on(channel, handler) {
  const wrapped = (_e, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('firmament', {
  app: {
    info: () => invoke('app:info'),
    bounds: () => invoke('win:bounds'),
    minimize: () => invoke('win:minimize'),
    /** 从透明迷你框形态退出后重新显示主窗口 */
    show: () => invoke('app:show'),
    maximize: () => invoke('win:maximize'),
    close: () => invoke('win:close'),
    isMaximized: () => invoke('win:is-maximized'),
    setFullScreen: (v) => invoke('win:set-fullscreen', v),
    isFullScreen: () => invoke('win:is-fullscreen'),
    setAlwaysOnTop: (v) => invoke('win:set-always-on-top', v),
    setOpacity: (v) => invoke('win:set-opacity', v),
    /** 迷你框自定义拖拽（按位移移动窗口） */
    moveBy: (dx, dy) => invoke('win:move-by', dx, dy),
    bounds: () => invoke('win:bounds'),
    setSize: (w, h) => invoke('win:set-size', w, h),
    openDevTools: () => invoke('app:open-devtools'),
    onMaximizeChange: (cb) => on('win:maximized-changed', cb),
    onFullScreenChange: (cb) => on('win:fullscreen-changed', cb),
  },

  books: {
    list: () => invoke('books:list'),
    import: (paths) => invoke('books:import', paths),
    importDialog: () => invoke('books:import-dialog'),
    importFolderDialog: () => invoke('books:import-folder-dialog'),
    scanFolder: (dir) => invoke('books:scan-folder', dir),
    remove: (id, deleteFile) => invoke('books:remove', id, deleteFile),
    update: (id, patch) => invoke('books:update', id, patch),
    toc: (id) => invoke('books:toc', id),
    chapter: (id, index) => invoke('books:chapter', id, index),
    search: (bookId, keyword, scope) => invoke('books:search', bookId, keyword, scope),
    validate: () => invoke('books:validate'),
    regenerateCovers: (force) => invoke('books:regenerate-covers', force),
    reload: (id) => invoke('books:reload', id),
    revealInFolder: (id) => invoke('books:reveal', id),
  },

  settings: {
    get: () => invoke('settings:get'),
    patch: (patch) => invoke('settings:patch', patch),
    reset: (scope) => invoke('settings:reset', scope),
  },

  fonts: {
    list: () => invoke('fonts:list'),
    importDialog: () => invoke('fonts:import-dialog'),
    import: (paths) => invoke('fonts:import', paths),
    remove: (file) => invoke('fonts:remove', file),
    refresh: () => invoke('fonts:refresh'),
    openFolder: () => invoke('fonts:open-folder'),
  },

  progress: {
    get: (bookId) => invoke('progress:get', bookId),
    set: (bookId, data) => invoke('progress:set', bookId, data),
    recent: () => invoke('progress:recent'),
    clear: (bookId) => invoke('progress:clear', bookId),
  },

  bookmarks: {
    list: (bookId) => invoke('bookmarks:list', bookId),
    add: (bookId, data) => invoke('bookmarks:add', bookId, data),
    remove: (bookId, id) => invoke('bookmarks:remove', bookId, id),
  },

  boss: {
    toggle: (on) => invoke('boss:toggle', on),
    state: () => invoke('boss:state'),
    setHotkey: (accel) => invoke('boss:set-hotkey', accel),
    apply: (opts) => invoke('boss:apply', opts),
    preview: (mode) => invoke('boss:preview', mode),
    onToggle: (cb) => on('boss:toggled', cb),
    /** 双角拖拽调整迷你框尺寸（anchor: 'br' 右下角 / 'bl' 左下角） */
    setBoxSize: (w, h, which, anchor) => invoke('boss:set-box-size', w, h, which, anchor),
    getBoxSize: (which) => invoke('boss:get-box-size', which),
    /** 透明浮窗诊断（冒烟测试 / 排查用） */
    overlayDiagnostics: () => invoke('boss:overlay-diagnostics'),
  },

  /** 透明迷你框浮窗专用（仅在 boss-overlay.html 里可用） */
  overlay: {
    snapshot: () => invoke('overlay:snapshot'),
    reportPosition: (pos) => invoke('overlay:position', pos),
    exit: () => invoke('overlay:exit'),
    onContent: (cb) => on('overlay:content', cb),
    onGeometry: (cb) => on('overlay:geometry', cb),
    /** 主题/墨色变化后请求重推快照 */
    refresh: () => invoke('overlay:refresh'),
  },

  dialog: {
    message: (opts) => invoke('dialog:message', opts),
    confirm: (opts) => invoke('dialog:confirm', opts),
  },

  shell: {
    openPath: (p) => invoke('shell:open-path', p),
    openExternal: (url) => invoke('shell:open-external', url),
  },

  onBooksChanged: (cb) => on('books:changed', cb),
  onOpenFile: (cb) => on('app:open-file', cb),
  onNavigate: (cb) => on('app:navigate', cb),
});