'use strict';

const { globalShortcut, BrowserWindow, screen } = require('electron');

/**
 * 摸鱼模式（老板键）。
 *
 * 三种形态：
 *   square —— 正方形迷你框：只有文字、无选项、无程序边框，最隐蔽（你指定的形态）
 *   normal —— 完整伪装窗口：仿 Word / Excel / VS Code / 邮件
 *   ghost  —— 隐身：窗口透明度降到极低，几乎看不见但仍在读
 *
 * 关键点：
 *   - 用 globalShortcut，窗口失焦时热键依然生效（这是能"瞬间摸鱼"的前提）
 *   - 切换只改窗口属性 + 切 DOM 显隐，不加载任何网络资源，保证 <150ms
 *   - 进入前精确保存窗口 bounds 与阅读位置，恢复时原样还原
 */

const RESTORE_FALLBACK = 'Control+Shift+Alt+R';
/**
 * 辅助切换热键。始终注册，不随用户设置变化。
 *
 * 存在的意义：老板键 Alt+` 极易与输入法切换、编辑器快捷键冲突而注册失败。
 * 一旦失败，用户就"进得去出不来"。保留一个固定不变的备用键，
 * 并在设置页明确告知，就能彻底避免这个死角。
 */
const ALTERNATE_TOGGLE = 'Control+Alt+Q';

/**
 * 常规阅读窗口的最小尺寸。
 *
 * ⚠ 这三个常量必须与 main.js 里创建窗口时的设定保持一致。
 *   早期把它们硬编码在两个文件里（900×620），既难改也容易失配，
 *   而 900px 的下限正是"窗口太宽、没法变窄"的直接原因。
 */
const MIN_W = 520;
const MIN_H = 460;

/** 常规窗口的恢复尺寸 */
const DEFAULT_W = 1180;
const DEFAULT_H = 800;

class BossMode {
  constructor(ctx) {
    this.ctx = ctx;
    this.active = false;
    this.saved = null;          // 进入前的窗口状态
    this.savedReadState = null; // 进入前的阅读位置
    this.registeredHotkey = null;
    this.hotkeyOk = true;
    this.hotkeyError = '';
    this.mutedBefore = false;
    this.escapeRegistered = false;
    this.escapeAccel = null;
    this.altToggleOk = false;
    this.restoreOk = false;
  }

  getWin() {
    return BrowserWindow.getAllWindows()[0] || null;
  }

  getOptions() {
    const s = this.ctx.store.get('settings') || {};
    return {
      hotkey: s.bossHotkey || 'Alt+`',
      mode: s.bossMode || 'fake-word',
      style: s.bossStyle || 'square',
      opacity: typeof s.bossOpacity === 'number' ? s.bossOpacity : 0.9,
      alwaysOnTop: s.bossAlwaysOnTop !== false,
      mute: s.bossMute !== false,
      miniBoxSize: s.miniBoxSize || 300,
    };
  }

  /** 注册全局老板键；返回是否成功（冲突时会失败） */
  registerHotkey(accel) {
    const target = accel || this.getOptions().hotkey;
    // 先清掉旧键，避免叠加
    if (this.registeredHotkey) {
      try { globalShortcut.unregister(this.registeredHotkey); } catch (_) {}
      this.registeredHotkey = null;
    }
    if (!target) return { ok: false, error: '未设置热键' };

    try {
      const ok = globalShortcut.register(target, () => this.toggle());
      if (ok && globalShortcut.isRegistered(target)) {
        this.registeredHotkey = target;
        this.hotkeyOk = true;
        this.hotkeyError = '';
      } else {
        this.hotkeyOk = false;
        this.hotkeyError = `热键 ${target} 已被其他程序占用，请换一个组合`;
      }
    } catch (err) {
      this.hotkeyOk = false;
      this.hotkeyError = `热键注册失败：${err.message}`;
    }

    // 兜底恢复键 + 辅助切换键，保证任何时候都能退出摸鱼模式
    const registerSafeKey = (accel, handler) => {
      try {
        if (globalShortcut.isRegistered(accel)) return true;
        globalShortcut.register(accel, handler);
        return globalShortcut.isRegistered(accel);
      } catch (_) {
        return false;
      }
    };

    this.altToggleOk = registerSafeKey(ALTERNATE_TOGGLE, () => this.toggle());
    this.restoreOk = registerSafeKey(RESTORE_FALLBACK, () => {
      if (this.active) this.toggle(false);
    });

    return { ok: this.hotkeyOk, error: this.hotkeyError, hotkey: this.registeredHotkey };
  }

  unregisterAll() {
    try { globalShortcut.unregisterAll(); } catch (_) {}
    this.registeredHotkey = null;
  }

  getState() {
    const opts = this.getOptions();
    return {
      active: this.active,
      ...opts,
      hotkeyOk: this.hotkeyOk,
      hotkeyError: this.hotkeyError,
      registeredHotkey: this.registeredHotkey,
      restoreFallback: RESTORE_FALLBACK,
      alternateToggle: ALTERNATE_TOGGLE,
      alternateToggleOk: !!this.altToggleOk,
      escapeExit: this.escapeRegistered,
      escapeAccel: this.escapeAccel || null,
      /** 至少有一条可用的退出通道 —— 用于界面提示 */
      canExit: this.hotkeyOk || this.escapeRegistered || !!this.altToggleOk || !!this.restoreOk,
    };
  }

  setHotkey(accel) {
    const r = this.registerHotkey(accel);
    this.ctx.store.patchSettings({ bossHotkey: accel });
    return { ...r, state: this.getState() };
  }

  applyOptions(opts) {
    const patch = {};
    if (opts.mode !== undefined) patch.bossMode = opts.mode;
    if (opts.style !== undefined) patch.bossStyle = opts.style;
    if (opts.opacity !== undefined) patch.bossOpacity = opts.opacity;
    if (opts.alwaysOnTop !== undefined) patch.bossAlwaysOnTop = opts.alwaysOnTop;
    if (opts.mute !== undefined) patch.bossMute = opts.mute;
    if (opts.miniBoxSize !== undefined) patch.miniBoxSize = opts.miniBoxSize;
    if (opts.hotkey !== undefined) patch.bossHotkey = opts.hotkey;
    this.ctx.store.patchSettings(patch);

    if (opts.hotkey !== undefined) this.registerHotkey(opts.hotkey);

    const win = this.getWin();
    if (win && this.active) {
      // 应用模式下实时生效
      this.applyWindowShape(win, this.getOptions());
      this.pushState();
    }
    return this.getState();
  }

  /** 依据 style 调整窗口几何与层级 */
  applyWindowShape(win, opts) {
    if (opts.style === 'square') {
      const size = Math.max(160, Math.min(560, Number(opts.miniBoxSize) || 300));
      const area = screen.getPrimaryDisplay().workAreaSize;

      // ⚠ 顺序至关重要（Windows 实测）：
      //   1. 先 setResizable(true)   —— 窗口若处于不可调整状态，setBounds 会被忽略
      //   2. 再 setMinimumSize(120)  —— 放开下限，否则被 520×460 钳住
      //   3. 然后 setBounds(300×300) —— 此时才真正生效
      //   4. 最后才 setResizable(false) 禁用调整
      //
      //   反例（踩过）：先 setResizable(false) 再 setBounds ——
      //   Windows 会把「最小尺寸」锁死为当前尺寸，于是
      //   getMinimumSize() 返回 [520,910]，窗口再也压不下去，
      //   表现为"摸鱼设置全对、窗口尺寸纹丝不动"。
      try { win.setResizable(true); } catch (_) {}
      win.setMinimumSize(120, 120);

      // 禁用双击标题栏最大化：迷你框内有拖拽区，
      // Windows 会把它当标题栏，双击就最大化铺满屏幕。
      // 摸鱼场景本就不该最大化，直接关掉最干净。
      this.setMaximizableSafe(win, false);

      const x = Math.max(0, area.width - size - 28);
      const y = 28;

      // ⚠ 必须"重试 + 每次校验"，不能一把梭。
      //   Windows 上 setBounds 在某些窗口状态下会被**静默忽略**
      //   （不抛错、也不生效）：实测在窗口尚未完成显示、
      //   刚退出最大化仍在过渡、以及最小尺寸被上一次
      //   setResizable(false) 锁死这几种情况下都会失败。
      //   所以这里循环尝试，每轮都读回实际值判断。
      for (let i = 0; i < 4; i++) {
        try { win.setBounds({ x, y, width: size, height: size }, false); } catch (_) {}
        let g = win.getBounds();
        if (Math.abs(g.width - size) <= 4 && Math.abs(g.height - size) <= 4) break;

        try { win.setSize(size, size, false); } catch (_) {}
        try { win.setPosition(x, y, false); } catch (_) {}
        g = win.getBounds();
        if (Math.abs(g.width - size) <= 4 && Math.abs(g.height - size) <= 4) break;

        // 仍未成功：重置可能锁死尺寸的状态再来一轮
        try { win.setResizable(true); } catch (_) {}
        try { win.setMinimumSize(120, 120); } catch (_) {}
        if (win.isMaximized()) { try { win.unmaximize(); } catch (_) {} }
      }

      // 尺寸落定后才禁 resize，并再次确认最小尺寸没被锁死
      try { win.setResizable(false); } catch (_) {}
      try { win.setMinimumSize(120, 120); } catch (_) {}

      const got = win.getBounds();
      if (Math.abs(got.width - size) > 4 || Math.abs(got.height - size) > 4) {
        console.warn('[boss] 迷你框尺寸未生效：目标 ' + size + '×' + size
          + '，实际 ' + got.width + '×' + got.height
          + '，minSize=' + JSON.stringify(win.getMinimumSize())
          + '，visible=' + win.isVisible() + '，maximized=' + win.isMaximized());
      }
      this.squareTarget = size;

      win.setAlwaysOnTop(!!opts.alwaysOnTop, 'screen-saver');
      win.setOpacity(1);
      win.setSkipTaskbar(true);
    } else if (opts.style === 'ghost') {
      this.squareTarget = null;
      win.setMinimumSize(120, 120);
      this.setMaximizableSafe(win, false);
      try { win.setResizable(false); } catch (_) {}
      win.setAlwaysOnTop(!!opts.alwaysOnTop, 'screen-saver');
      win.setOpacity(0.06);
      win.setSkipTaskbar(true);
    } else {
      this.squareTarget = null;
      // normal：恢复常规窗口约束，只做标题伪装
      this.setMaximizableSafe(win, true);
      try { win.setResizable(true); } catch (_) {}
      win.setMinimumSize(MIN_W, MIN_H);
      win.setAlwaysOnTop(false);
      win.setOpacity(Math.max(0.3, Math.min(1, opts.opacity)));
      win.setSkipTaskbar(false);
    }
  }

  /**
   * 显示完成后补一次尺寸确认。
   *
   * ⚠ 为什么要这一步：Windows 对「尚未完成显示的窗口」的 setBounds
   *   会静默忽略。而进入摸鱼时窗口可能正处于隐藏状态（或刚被 showInactive
   *   唤醒），那一轮的 setBounds 会全部落空。等显示真正完成后再验一次，
   *   才能在用户看到窗口之前把尺寸纠正过来。
   */
  ensureSquareAfterShow(win, delay) {
    const wait = delay == null ? 300 : delay;
    setTimeout(() => {
      if (!this.active || !this.squareTarget || win.isDestroyed()) return;
      const size = this.squareTarget;
      const g = win.getBounds();
      if (Math.abs(g.width - size) <= 4 && Math.abs(g.height - size) <= 4) return;
      if (win.isMaximized()) { try { win.unmaximize(); } catch (_) {} }
      try { win.setResizable(true); } catch (_) {}
      try { win.setMinimumSize(120, 120); } catch (_) {}
      try { win.setBounds({ x: g.x, y: g.y, width: size, height: size }, false); } catch (_) {}
      try { win.setSize(size, size, false); } catch (_) {}
      try { win.setResizable(false); } catch (_) {}
      try { win.setMinimumSize(120, 120); } catch (_) {}
      const f = win.getBounds();
      if (Math.abs(f.width - size) > 4 || Math.abs(f.height - size) > 4) {
        console.warn('[boss] 显示后补偿仍失败：' + f.width + '×' + f.height + '（目标 ' + size + '）');
      }
    }, wait);
  }

  /** 安全地设置可最大化状态（部分平台/Linux 窗口管理器可能不支持） */
  setMaximizableSafe(win, v) {
    try { win.setMaximizable(!!v); } catch (_) {}
  }

  /**
   * 等待窗口从「最大化 / 全屏」真正还原。
   *
   * ⚠ 为什么需要：unmaximize() / setFullScreen(false) 是异步的，
   *   调用后窗口在若干帧内仍处于过渡态，此时 setBounds 会被系统忽略。
   *   这是"摸鱼设置全都对、窗口尺寸却纹丝不动"的直接原因。
   */
  waitWindowStateSettled(win, timeout) {
    const limit = timeout || 600;
    return new Promise((resolve) => {
      const t0 = Date.now();
      const check = () => {
        if (win.isDestroyed()) return resolve(false);
        if (!win.isMaximized() && !win.isFullScreen()) return resolve(true);
        if (Date.now() - t0 > limit) return resolve(false);
        setTimeout(check, 30);
      };
      check();
    });
  }

  /** 伪装标题：让任务栏 / Alt-Tab 里看起来像正经文档 */
  fakeTitle(mode) {
    const map = {
      'fake-word': '会议纪要.docx - Word',
      'fake-excel': 'Q3经营数据分析.xlsx - Excel',
      'fake-code': 'server.ts - Visual Studio Code',
      'fake-mail': '收件箱 (12) - Outlook',
      'mini-text': '便签',
      'blank': '',
    };
    return map[mode] || '文档';
  }

  pushState() {
    const win = this.getWin();
    const state = this.getState();
    if (win && !win.isDestroyed()) {
      win.webContents.send('boss:toggled', state);
    }
    // 让渲染层能同步迷你框标题
    this.ctx.onBossChange && this.ctx.onBossChange(state);
  }

  /**
   * 注册/注销「按 Esc 退出摸鱼」的全局快捷键。
   *
   * 这是进得去出不来的最后一道保险：进入摸鱼时窗口不抢焦点，
   * 渲染层收不到键盘事件，只能靠全局快捷键兜底。
   */
  registerEscapeExit() {
    if (this.escapeRegistered) return;

    // 依次尝试候选退出键，取第一个能注册成功的。
    // 裸 Escape 在部分系统上会被拒绝注册（它属于"普通按键"而非组合键），
    // 所以必须准备降级方案，不能只试一个就放弃。
    const candidates = ['Escape', 'Control+Escape', 'Alt+Escape', 'Control+Shift+Escape'];
    for (const accel of candidates) {
      try {
        if (globalShortcut.isRegistered(accel)) continue;
        const ok = globalShortcut.register(accel, () => {
          if (this.active) this.toggle(false);
        });
        if (ok && globalShortcut.isRegistered(accel)) {
          this.escapeRegistered = true;
          this.escapeAccel = accel;
          return;
        }
      } catch (_) {
        // 继续尝试下一个
      }
    }
    this.escapeRegistered = false;
    this.escapeAccel = null;
    console.warn('[boss] 退出快捷键注册失败，将依赖老板键与界面按钮退出。');
  }

  unregisterEscapeExit() {
    if (!this.escapeRegistered) return;
    const accel = this.escapeAccel;
    try { if (accel) globalShortcut.unregister(accel); } catch (_) {}
    try {
      ['Escape', 'Control+Escape', 'Alt+Escape', 'Control+Shift+Escape'].forEach((a) => {
        if (globalShortcut.isRegistered(a)) globalShortcut.unregister(a);
      });
    } catch (_) {}
    this.escapeRegistered = false;
    this.escapeAccel = null;
  }

  /**
   * @param {boolean|undefined} on  true 进入 / false 退出 / undefined 切换
   */
  async toggle(on) {
    const win = this.getWin();
    if (!win || win.isDestroyed()) return this.getState();
    const want = typeof on === 'boolean' ? on : !this.active;
    if (want === this.active) return this.getState();

    const opts = this.getOptions();

    if (want) {
      // —— 进入摸鱼 ——
      this.saved = {
        bounds: win.getBounds(),
        wasMaximized: win.isMaximized(),
        wasFullScreen: win.isFullScreen(),
        wasAlwaysOnTop: win.isAlwaysOnTop(),
        wasSkipTaskbar: win.isSkipTaskbar ? win.isSkipTaskbar() : false,
        title: win.getTitle(),
        opacity: win.getOpacity(),
      };

      // ⚠ 取消最大化 / 退出全屏是**异步**的：调完 unmaximize() 之后，
      //   窗口在若干帧内仍处于"正在还原"的过渡态。此时调用 setBounds
      //   会被 Windows 直接忽略 —— 表现就是"摸鱼设置全对，窗口尺寸纹丝不动"。
      //   必须等状态真正落定再改尺寸。
      if (this.saved.wasMaximized || this.saved.wasFullScreen) {
        if (this.saved.wasMaximized) { try { win.unmaximize(); } catch (_) {} }
        if (this.saved.wasFullScreen) { try { win.setFullScreen(false); } catch (_) {} }
        await this.waitWindowStateSettled(win, 600);
      }

      win.setTitle(this.fakeTitle(opts.mode));

      // ⚠ 顺序修正（决定性）：必须先让窗口可见，再改尺寸。
      //
      //   Windows 对**不可见**窗口的 setBounds / setSize 会静默忽略 ——
      //   不报错，也不生效。进入摸鱼时窗口可能正处于隐藏状态，
      //   若沿用「先 setBounds 再 showInactive」的旧顺序，那一轮尺寸调整
      //   会全部落空，用户看到的就是"窗口纹丝不动"。
      //   独立测试已验证：窗口 show 之后同样的 setBounds 立刻生效。
      win.showInactive();

      this.applyWindowShape(win, opts);
      // 显示完成后补一次确认（应对仍在过渡态的情况）
      this.ensureSquareAfterShow(win, 280);

      if (opts.mute && !win.webContents.isAudioMuted()) {
        win.webContents.setAudioMuted(true);
        this.mutedBefore = false;
      }

      // 注册 Esc 作为"退出摸鱼"的兜底。
      //
      // 为什么需要：进入摸鱼用的是 showInactive()（故意不抢焦点），
      // 所以键盘事件根本到不了渲染层，渲染层的 Esc 处理完全无效。
      // 如果用户自定义的老板键又恰好注册失败（Alt+` 常与输入法冲突），
      // 就会陷入"进得去出不来"。这里用全局 Esc 彻底堵住这个死角：
      // Esc 是"退出当前状态"的通用心智模型，用户第一反应就是按它。
      this.registerEscapeExit();
      this.active = true;
    } else {
      this.unregisterEscapeExit();
      // —— 退出摸鱼 ——
      const s = this.saved || {};

      // 先恢复常规窗口约束与能力，再恢复尺寸，否则会被迷你尺寸限制住
      this.setMaximizableSafe(win, true);
      try { win.setResizable(true); } catch (_) {}
      win.setMinimumSize(MIN_W, MIN_H);
      win.setSkipTaskbar(false);
      win.setAlwaysOnTop(!!s.wasAlwaysOnTop);
      win.setOpacity(typeof s.opacity === 'number' ? s.opacity : 1);
      win.setTitle(s.title || '苍穹');

      if (s.bounds) win.setBounds(s.bounds, false);
      if (s.wasMaximized) win.maximize();
      if (s.wasFullScreen) win.setFullScreen(true);

      if (opts.mute && this.mutedBefore === false) {
        win.webContents.setAudioMuted(false);
      }
      this.active = false;
      this.saved = null;
    }

    this.pushState();
    return this.getState();
  }

  /**
   * 迷你框拖动。渲染层用自定义拖拽（而不是 -webkit-app-region:drag）时，
   * 通过这里把鼠标位移换算成窗口新位置。
   *
   * 为什么不用 CSS 拖拽区：那个区域会吃掉鼠标事件，
   * 导致内部元素上的 dblclick 根本不触发（"双击顶部无法退出"）。
   */
  moveBy(dx, dy) {
    const win = this.getWin();
    if (!win || win.isDestroyed()) return false;
    if (win.isMaximized()) return false;
    const b = win.getBounds();
    win.setBounds({
      x: Math.round(b.x + (Number(dx) || 0)),
      y: Math.round(b.y + (Number(dy) || 0)),
      width: b.width,
      height: b.height,
    }, false);
    return true;
  }

  /** 只预览某个伪装界面（不改变窗口形态），用于设置页预览 */
  preview(mode) {
    const win = this.getWin();
    if (!win) return false;
    win.webContents.send('boss:preview', { mode });
    return true;
  }
}

module.exports = { BossMode, RESTORE_FALLBACK, ALTERNATE_TOGGLE, MIN_W, MIN_H, DEFAULT_W, DEFAULT_H };