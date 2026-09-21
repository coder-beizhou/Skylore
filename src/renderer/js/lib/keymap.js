'use strict';

/**
 * 全局快捷键中心。
 *
 * 为什么单独抽一个模块：全应用的快捷键散落在 app.js（全局）、reader.js
 * （阅读页）等多处，若各自解析，设置页就无从"统一列出、统一改写"。
 * 这里把**所有可配置的快捷键**收敛成一张表：
 *   · 表里每个条目有唯一 action、默认组合、说明与作用域
 *   · 用户自定义值存进 settings.keybindings[action]
 *   · 冲突检测集中在这里做（同一个组合键不允许绑两个动作）
 *
 * 不在表里的键（如 Esc、F11）属于"系统级/约定俗成"的操作，
 * 刻意不开放自定义 —— 尤其是 Esc（退出摸鱼、逐层退出）和
 * 老板键（由主进程 globalShortcut 注册），改坏了会导致"进得去出不来"。
 */

/**
 * 动作定义。
 *
 * scope: 'global' —— 任何视图都生效
 *        'reader' —— 仅在阅读页生效
 */
export const ACTIONS = [
  { action: 'reader.search',   def: 'Ctrl+F', scope: 'reader', label: '搜索正文',     desc: '在当前书籍中查找关键词' },
  { action: 'reader.bookmark', def: 'Ctrl+B', scope: 'reader', label: '添加书签',     desc: '在当前位置加一个书签' },
  { action: 'reader.settings', def: 'Ctrl+,', scope: 'reader', label: '阅读设置面板', desc: '打开字号/行距/主题等快速设置' },
  { action: 'reader.toc',      def: 'Ctrl+T', scope: 'reader', label: '目录',        desc: '打开章节目录抽屉' },
  { action: 'reader.fontUp',   def: 'Ctrl+=', scope: 'reader', label: '增大字号',     desc: '字号加一档' },
  { action: 'reader.fontDown', def: 'Ctrl+-', scope: 'reader', label: '减小字号',     desc: '字号减一档' },
  { action: 'reader.dark',     def: 'Ctrl+D', scope: 'reader', label: '明暗切换',     desc: '在日间与夜间主题之间切换' },
  { action: 'reader.boss',     def: 'Ctrl+Shift+B', scope: 'reader', label: '摸鱼菜单', desc: '打开摸鱼模式选择菜单' },
  { action: 'book.import',     def: 'Ctrl+O', scope: 'global', label: '导入小说',     desc: '打开文件选择框导入 TXT / EPUB' },
  { action: 'app.fullscreen',  def: 'F11',    scope: 'global', label: '全屏切换',     desc: '切换窗口全屏' },
];

/** 归一化按键名：把各种写法收敛成 Electron/DOM 通用形式 */
export function normalizeKey(e) {
  const k = e.key;
  if (!k) return '';
  if (k === ' ') return 'Space';
  if (k === 'Esc' || k === 'Escape') return 'Escape';
  if (k === 'ArrowUp') return 'Up';
  if (k === 'ArrowDown') return 'Down';
  if (k === 'ArrowLeft') return 'Left';
  if (k === 'ArrowRight') return 'Right';
  if (k === 'PageUp') return 'PageUp';
  if (k === 'PageDown') return 'PageDown';
  if (k.length === 1) return k.toUpperCase();
  return k;
}

/** 从键盘事件生成组合键字符串（与主进程 globalShortcut 的写法兼容） */
export function comboFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');

  const raw = normalizeKey(e);
  // 仅按修饰键本身时不产生组合
  if (!raw || ['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(raw)) return '';

  const key = raw === 'Space' ? 'Space' : raw;
  return mods.length ? [...mods, key].join('+') : key;
}

/** 展示用：把 Ctrl 换成更易读的符号（Windows 习惯） */
export function prettyCombo(combo) {
  if (!combo) return '未设置';
  return String(combo)
    .replace(/\bCtrl\b/g, 'Ctrl')
    .replace(/\bMeta\b/g, 'Win')
    .replace(/\+/g, ' + ');
}

/**
 * 与键盘事件比对。
 * @param {KeyboardEvent} e
 * @param {string} combo 形如 'Ctrl+Shift+B'
 */
export function matches(e, combo) {
  if (!combo) return false;
  const want = combo.split('+');
  const needCtrl = want.includes('Ctrl');
  const needAlt = want.includes('Alt');
  const needShift = want.includes('Shift');
  const needMeta = want.includes('Meta');
  const key = want[want.length - 1];

  if (!!e.ctrlKey !== needCtrl) return false;
  if (!!e.altKey !== needAlt) return false;
  if (!!e.shiftKey !== needShift) return false;
  if (!!e.metaKey !== needMeta) return false;

  return normalizeKey(e).toLowerCase() === key.toLowerCase();
}

/**
 * 快捷键管理器。
 *
 * 用法：在需要的地方 holder.resolve('reader.search') 拿到当前生效组合，
 * 用户在设置页改键后立刻生效（无需重启）。
 */
export class Keymap {
  constructor(settings) {
    this.settings = settings || {};
  }

  /** 用户自定义优先，否则用默认值 */
  resolve(action) {
    const custom = (this.settings.keybindings || {})[action];
    if (custom) return custom;
    const def = ACTIONS.find((a) => a.action === action);
    return def ? def.def : '';
  }

  /** 该动作是否被用户改过（设置页要显示"恢复默认"） */
  isCustom(action) {
    return !!(this.settings.keybindings || {})[action];
  }

  /** 查找某个组合键被谁占用（排除 exceptAction 自身） */
  conflictOf(combo, exceptAction) {
    const norm = String(combo || '').toLowerCase();
    if (!norm) return null;
    for (const a of ACTIONS) {
      if (a.action === exceptAction) continue;
      if (String(this.resolve(a.action)).toLowerCase() === norm) return a;
    }
    return null;
  }

  /** 生成设置补丁：写入一次改键 */
  patchFor(action, combo) {
    const kb = Object.assign({}, this.settings.keybindings || {});
    if (!combo) delete kb[action];
    else kb[action] = combo;
    return { keybindings: kb };
  }

  /** 生成设置补丁：清空全部自定义（恢复出厂键位） */
  static resetPatch() {
    return { keybindings: {} };
  }
}
