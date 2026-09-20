import { $, $$, el, clear, esc, clamp, on, delegate, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast, call } from '../lib/toast.js';
import { THEMES, TEXTURES, SKINS } from '../lib/theme.js';

/**
 * 完整设置页。分七个面板：
 *   阅读排版 / 主题外观 / 字体 / 翻页与自动 / 摸鱼模式 / 数据与存储 / 关于
 */

const NAV = [
  { key: 'typography', label: '阅读排版', icon: 'type' },
  { key: 'appearance', label: '主题外观', icon: 'palette' },
  { key: 'fonts', label: '字体管理', icon: 'text' },
  { key: 'paging', label: '翻页与自动', icon: 'pages' },
  { key: 'boss', label: '摸鱼模式', icon: 'ghost' },
  { key: 'data', label: '数据与存储', icon: 'folder' },
  { key: 'about', label: '关于苍穹', icon: 'info' },
];

export class SettingsView {
  constructor({ state, bus, app }) {
    this.state = state;
    this.bus = bus;
    this.app = app;
    this.api = window.firmament;
    this.active = 'typography';
    this.appInfo = null;
    this.bossState = null;
  }

  async init() {
    this.renderNav();

    const [info, bossState] = await Promise.all([
      call(this.api.app.info(), { silent: true }),
      call(this.api.boss.state(), { silent: true }),
    ]);
    this.appInfo = info || {};
    this.bossState = bossState || {};

    // 预加载内置字体。
    // ⚠ 必须显式 load 并等待——字体是异步加载的，若不等，
    //   字体管理页里"以自身字体渲染的预览"会全部回退成默认宋体，
    //   用户会以为内置字体没生效。
    await this.preloadBuiltinFonts();

    this.render();
    this.bus.on('fonts:changed', () => { if (this.state.view === 'settings') this.render(); });
    this.bus.on('route', (v) => { if (v === 'settings') this.render(); });
  }

  /** 等待内置字体就绪，确保字体预览真实可信 */
  async preloadBuiltinFonts() {
    const builtins = (this.state.fonts || []).filter((f) => f.builtin && f.probe);
    if (!builtins.length) return;
    const sample = '春江潮水连海平';
    await Promise.all(builtins.map(async (f) => {
      try {
        await document.fonts.load(`16px "${f.probe}"`, sample);
      } catch (_) {}
    }));
    // 等浏览器完成字体注册
    try { await document.fonts.ready; } catch (_) {}
  }

  renderNav() {
    const host = $('#settingsNav');
    clear(host);
    NAV.forEach((n) => {
      const b = el('button.settings-nav__item', {
        class: n.key === this.active ? 'is-active' : '',
        dataset: { pane: n.key },
        html: icon(n.icon, 16) + `<span>${n.label}</span>`,
      });
      b.addEventListener('click', () => {
        this.active = n.key;
        this.renderNav();
        this.render();
      });
      host.appendChild(b);
    });
  }

  render() {
    const host = $('#settingsBody');
    clear(host);
    const pane = el('div.settings-pane.is-active');
    host.appendChild(pane);

    const builders = {
      typography: () => this.renderTypography(pane),
      appearance: () => this.renderAppearance(pane),
      fonts: () => this.renderFonts(pane),
      paging: () => this.renderPaging(pane),
      boss: () => this.renderBoss(pane),
      data: () => this.renderData(pane),
      about: () => this.renderAbout(pane),
    };
    (builders[this.active] || builders.typography)();
  }

  /** 设置页打开时同步最新值（阅读页改动后） */
  syncFromState() {
    if (this.state.view === 'settings') this.render();
  }

  /* ======================== 公共组件 ======================== */

  paneHeader(pane, title, desc) {
    pane.appendChild(el('h2.settings-pane__title', { text: title }));
    if (desc) pane.appendChild(el('p.settings-pane__desc', { text: desc }));
  }

  row(pane, name, hint, control) {
    const r = el('div.setting-row', {}, [
      el('div.setting-row__label', {}, [
        el('span.setting-row__name', { text: name }),
        hint ? el('span.setting-row__hint', { text: hint }) : null,
      ]),
      el('div.setting-row__control', { class: Array.isArray(control) ? 'setting-row__control--stack' : '' },
        Array.isArray(control) ? control : [control]),
    ]);
    pane.appendChild(r);
    return r;
  }

  sliderRow(pane, name, hint, key, min, max, step, unit, format, onChange) {
    const s = this.state.settings;
    const valText = el('span.setting-row__num', {
      text: format ? format(s[key]) : `${s[key]}${unit}`,
    });
    const input = el('input.range', {
      type: 'range', min: String(min), max: String(max), step: String(step), value: String(s[key]),
    });
    input.addEventListener('input', () => {
      const v = Number(input.value);
      valText.textContent = format ? format(v) : `${v}${unit}`;
      this.patch({ [key]: v });
      if (onChange) onChange(v);
    });
    return this.row(pane, name, hint, [
      el('div.setting-row__slider', {}, [input, valText]),
    ]);
  }

  switchRow(pane, name, hint, key, onChange) {
    const s = this.state.settings;
    const sw = el('button.switch', {
      class: s[key] ? 'is-on' : '',
      type: 'button',
      'aria-pressed': s[key] ? 'true' : 'false',
    });
    sw.addEventListener('click', () => {
      const next = !sw.classList.contains('is-on');
      sw.classList.toggle('is-on', next);
      sw.setAttribute('aria-pressed', next ? 'true' : 'false');
      this.patch({ [key]: next });
      if (onChange) onChange(next);
    });
    return this.row(pane, name, hint, sw);
  }

  selectRow(pane, name, hint, key, options, onChange) {
    const s = this.state.settings;
    const sel = el('select.select');
    options.forEach((o) => {
      const opt = el('option', { value: String(o.value), text: o.label });
      if (String(s[key]) === String(o.value)) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      const raw = sel.value;
      const opt = options.find((o) => String(o.value) === raw);
      const v = opt && typeof opt.value === 'number' ? Number(raw) : raw;
      this.patch({ [key]: v });
      if (onChange) onChange(v);
    });
    return this.row(pane, name, hint, sel);
  }

  segmentRow(pane, name, hint, key, options, onChange) {
    const s = this.state.settings;
    const seg = el('div.segment', { style: { width: '100%' } });
    options.forEach((o) => {
      const b = el('button.segment__item', {
        class: String(s[key]) === String(o.value) ? 'is-active' : '',
        style: { flex: '1', justifyContent: 'center', gap: '6px' },
        html: (o.icon ? icon(o.icon, 15) : '') + `<span>${o.label}</span>`,
      });
      b.addEventListener('click', () => {
        $$('.segment__item', seg).forEach((x) => x.classList.remove('is-active'));
        b.classList.add('is-active');
        this.patch({ [key]: o.value });
        if (onChange) onChange(o.value);
      });
      seg.appendChild(b);
    });
    return this.row(pane, name, hint, seg);
  }

  /** 保存设置：立即生效 + 防抖落盘 + 阅读区重排 */
  patch(patch, opts) {
    const o = opts || {};
    this.state.settings = { ...this.state.settings, ...patch };
    this.app.theme.settings = this.state.settings;
    this.app.theme.apply();
    if (o.layout !== false && this.app.reader) this.app.reader.reflow();
    this.app.saveSettings(patch);
    this.bus.emit('settings:changed', patch);
  }

  /* ======================== 1. 阅读排版 ======================== */

  renderTypography(pane) {
    const s = this.state.settings;
    this.paneHeader(pane, '阅读排版', '所有改动会立即应用到当前打开的书籍，并自动保存。');

    // 实时预览
    pane.appendChild(el('div.font-preview', {}, [
      el('div.font-preview__line', {
        html: `<p>夜色像一层薄薄的墨，慢慢浸透了整条巷子。</p>
               <p>"你来了。"他说，声音很轻，仿佛怕惊动了什么。</p>
               <p>The wind was rising, and somewhere far away a bell began to toll.</p>`,
      }),
    ]));

    this.sliderRow(pane, '字号', '12 - 40 px', 'fontSize', 12, 40, 1, 'px', null, () => this.refreshPreview());
    this.sliderRow(pane, '行间距', '中文正文建议 1.6 - 2.0', 'lineHeight', 1.1, 3.0, 0.05, '',
      (v) => Number(v).toFixed(2), () => this.refreshPreview());
    this.sliderRow(pane, '字间距', '适度增加可缓解密集感', 'letterSpacing', -0.04, 0.30, 0.01, 'em',
      (v) => Number(v).toFixed(2) + 'em', () => this.refreshPreview());

    this.sliderRow(pane, '段间距', '段落之间的空白', 'paragraphSpacing', 0, 2.4, 0.1, 'em',
      (v) => Number(v).toFixed(1) + 'em', () => this.refreshPreview());
    this.sliderRow(pane, '首行缩进', '中文习惯为 2 个字', 'paragraphIndent', 0, 4, 0.5, '字',
      (v) => Number(v).toFixed(1) + ' 字', () => this.refreshPreview());

    this.segmentRow(pane, '对齐方式', '两端对齐更接近纸书观感', 'textAlign', [
      { value: 'justify', label: '两端对齐' },
      { value: 'left', label: '左对齐' },
    ], () => this.refreshPreview());

    this.selectRow(pane, '字重', '细体在夜间模式下更柔和', 'fontWeight', [
      { value: 300, label: '细体 300' },
      { value: 400, label: '常规 400' },
      { value: 500, label: '中等 500' },
      { value: 600, label: '半粗 600' },
    ], () => this.refreshPreview());

    pane.appendChild(el('div', { style: { height: '24px' } }));

    // ⚠ 这两行曾导致「左右页边距不一致」这个真实 bug。
    //
    //   滑杆绑定的 key 是 marginLeft，但回调只把 marginRight 写成 v：
    //     拖动 → marginLeft 被 sliderRow 内部改成新值
    //          → 回调又把 marginRight 也写成同一个新值
    //   看起来该对称？问题在于 sliderRow 内部只写 **绑定的那个 key**，
    //   而回调再写一次 marginRight —— 两次写入的值来源不同（一次是
    //   滑杆内部状态、一次是回调参数），一旦中间被其它 patch 干扰，
    //   两者就会永久失配（实测用户配置里 marginLeft=88 / marginRight=40）。
    //   而且用户根本看不出差在哪，只知道"左边空得多"。
    //
    //   现在统一由回调同时写入两侧，保证任何情况下都相等。
    this.sliderRow(pane, '上下边距', '正文距窗口上下边缘的距离', 'marginTop', 16, 200, 4, 'px',
      null, (v) => {
        this.state.settings.marginBottom = v;
        this.app.saveSettings({ marginBottom: v });
      });
    this.sliderRow(pane, '左右边距', '宽屏下适当加大更护眼', 'marginLeft', 16, 320, 4, 'px',
      null, (v) => {
        // 左右必须同值 —— 分别设置会让正文偏向一侧
        this.state.settings.marginRight = v;
        this.app.saveSettings({ marginLeft: v, marginRight: v });
      });
    this.sliderRow(pane, '正文最大宽度', '0 表示随窗口自适应', 'contentWidth', 0, 1200, 20, 'px',
      (v) => (Number(v) <= 400 ? '自适应' : v + 'px'));

    pane.appendChild(el('div', { style: { height: '20px' } }));
    this.switchRow(pane, '对话行不缩进', '纸书排版惯例：对话段落顶格', 'dialogNoIndent');
    this.switchRow(pane, '超长段落自动拆分', '单段超过 220 字时在句末断开，减轻疲劳', 'splitLongParagraph');
    this.switchRow(pane, '分隔符美化', '把 **** / ---- 等渲染成居中分隔符', 'decorateSeparator');
  }

  refreshPreview() {
    const p = $('.font-preview__line');
    if (!p) return;
    // CSS 变量已在 theme.apply 中更新，这里无需额外操作
    p.style.transition = 'none';
    requestAnimationFrame(() => { p.style.transition = ''; });
  }

  /* ======================== 2. 主题外观 ======================== */

  renderAppearance(pane) {
    const s = this.state.settings;
    this.paneHeader(pane, '主题外观', '主题决定配色，皮肤决定质感，两者可自由组合。');

    // 主题
    const themeGrid = el('div.theme-row');
    THEMES.forEach((t) => {
      const chip = el('button.theme-chip', { class: t.key === s.theme ? 'is-active' : '' }, [
        el('span.theme-chip__swatch', {}, t.swatch.map((c) => el('i', { style: { background: c } }))),
        el('span.theme-chip__name', { text: t.label }),
      ]);
      chip.addEventListener('click', () => {
        this.patch({ theme: t.key });
        this.render();
      });
      themeGrid.appendChild(chip);
    });
    this.row(pane, '配色主题', '含日间、夜间与低刺激护眼方案', themeGrid);

    // 皮肤
    const skinRow = el('div.skin-row', { style: { width: '100%' } });
    SKINS.forEach((sk) => {
      const chip = el('button.skin-chip', {
        class: `${sk.key === s.skin ? 'is-active' : ''} skin-chip--${sk.key}`,
        style: { flex: '1' },
      }, [
        el('span.skin-chip__demo', {}, [el('i'), el('i'), el('i')]),
        el('span.skin-chip__label', { text: sk.label }),
        el('span.text-xs.text-tertiary', { text: sk.desc, style: { textAlign: 'center' } }),
      ]);
      chip.addEventListener('click', () => {
        this.patch({ skin: sk.key }, { layout: false });
        this.render();
      });
      skinRow.appendChild(chip);
    });
    this.row(pane, '界面皮肤', '极简通透 / 拟物书卷', skinRow);

    pane.appendChild(el('div', { style: { height: '20px' } }));

    // 背景纹理
    const bgGrid = el('div.bg-grid', { style: { width: '100%' } });
    TEXTURES.forEach((t) => {
      const isNone = t.key === 'none';
      const chip = el('button.bg-chip', {
        class: `${t.key === s.background ? 'is-active' : ''} ${isNone ? 'bg-chip--none' : ''}`,
        title: t.label,
        style: !isNone && t.css ? { backgroundImage: t.css, backgroundSize: t.size || 'auto' } : {},
      }, isNone ? [el('span', { text: '无' })] : null);
      chip.addEventListener('click', () => {
        this.patch({ background: t.key }, { layout: false });
        this.app.theme.applyBackground(this.state.settings);
        this.render();
      });
      bgGrid.appendChild(chip);
    });
    this.row(pane, '背景纹理', '全部由 CSS 生成，不占体积', bgGrid);

    this.sliderRow(pane, '纹理浓度', '纹理过重会影响文字可读性', 'bgOpacity', 0, 1, 0.02, '',
      (v) => Math.round(v * 100) + '%',
      () => this.app.theme.applyBackground(this.state.settings));

    this.sliderRow(pane, '屏幕亮度', '模拟亮度调节，不全屏变暗', 'brightness', 0.4, 1.4, 0.05, '',
      (v) => Math.round(v * 100) + '%',
      (v) => this.app.reader && this.app.reader.__applyBrightness && this.app.reader.__applyBrightness(v));

    pane.appendChild(el('div', { style: { height: '20px' } }));
    this.switchRow(pane, '高对比度', '增强文字与背景对比，适合弱光或视力不佳时使用', 'highContrast');
    this.switchRow(pane, '书架显示进度环', '在封面底部显示阅读进度', 'showProgressRing');
  }

  /* ======================== 3. 字体管理 ======================== */

  async renderFonts(pane) {
    // 每次渲染字体页前再确认一次内置字体已就绪（用户可能刚切换过视图）
    await this.preloadBuiltinFonts();

    this.paneHeader(pane, '字体管理', '苍穹会自动探测本机真安装的字体，未安装的字体会标注提示，避免出现「换了没反应」的情况。');

    // 当前字体
    const cur = this.state.fonts.find((f) => f.family === this.state.settings.fontFamily);
    const curRow = el('div.flex.items-center.gap-3', { style: { width: '100%' } }, [
      el('span', {
        text: cur ? cur.label : '跟随主题默认',
        style: { fontFamily: this.state.settings.fontFamily, fontSize: '20px', flex: '1' },
      }),
      el('span.text-sm.text-tertiary', { text: `${this.state.fonts.length} 种可用` }),
    ]);
    this.row(pane, '当前字体', null, curRow);

    // 分组展示
    const groups = new Map();
    this.state.fonts.forEach((f) => {
      const g = f.group || '其他';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(f);
    });

    const order = ['我的字体', '内置手写', '内置圆体', '中文常用', '圆体', '手写体', '楷体', '西文', '系统'];
    const sorted = [...groups.entries()].sort((a, b) => {
      const ia = order.indexOf(a[0]); const ib = order.indexOf(b[0]);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });

    for (const [groupName, fonts] of sorted) {
      const wrap = el('div', { style: { width: '100%', display: 'flex', flexDirection: 'column', gap: '2px' } });
      fonts.forEach((f) => {
        const isActive = f.family === this.state.settings.fontFamily;
        const missing = f.installed === false;
        const row = el('button.font-option', {
          class: isActive ? 'is-active' : '',
          style: { border: '1px solid transparent', borderRadius: '8px' },
        }, [
          el('span.font-option__sample', { text: `${f.label}　春江潮水连海平`, style: { fontFamily: f.family } }),
          f.user ? el('span.font-option__tag.font-option__tag--custom', { text: '已导入' }) : null,
          missing ? el('span.font-option__tag.font-option__tag--missing', { text: '未安装' }) : null,
          isActive ? el('span', { html: icon('check', 16), style: { display: 'flex', color: 'var(--c-accent)' } }) : null,
          f.user ? (() => {
            const d = el('span.font-option__del', { html: icon('trash', 13), title: '删除该字体' });
            d.addEventListener('click', async (e) => {
              e.stopPropagation();
              const ok = await call(this.api.dialog.confirm({
                title: '删除字体',
                message: `确定要删除「${f.label}」吗？`,
                detail: '会从苍穹的字体目录中移除该文件，不影响系统字体。',
                buttons: ['取消', '删除'],
              }), { silent: true });
              if (!ok) return;
              const res = await call(this.api.fonts.remove(f.file));
              if (res) {
                this.state.fonts = res.list;
                this.patch({ fontFamily: '"Microsoft YaHei", sans-serif' });
                this.render();
                toast.success('已删除字体');
              }
            });
            return d;
          })() : null,
        ]);

        row.addEventListener('click', () => {
          if (missing) toast.error(`本机未安装「${f.label}」`, { duration: 3000 });
          this.patch({ fontFamily: f.family });
          this.loadFontFace(f);
          this.render();
        });
        wrap.appendChild(row);
      });
      this.row(pane, groupName, null, wrap);
    }

    pane.appendChild(el('div', { style: { height: '20px' } }));

    // 操作按钮
    pane.appendChild(el('div.flex.gap-2', { style: { flexWrap: 'wrap' } }, [
      (() => {
        const b = el('button.btn.btn--solid', { html: icon('upload', 15) + '<span>导入字体文件</span>' });
        b.addEventListener('click', () => this.importFonts());
        return b;
      })(),
      (() => {
        const b = el('button.btn.btn--ghost', { html: icon('folder', 15) + '<span>打开字体目录</span>' });
        b.addEventListener('click', () => call(this.api.fonts.openFolder(), { silent: true }));
        return b;
      })(),
      (() => {
        const b = el('button.btn.btn--ghost', { html: icon('refresh', 15) + '<span>重新探测系统字体</span>' });
        b.addEventListener('click', async () => {
          const list = await call(this.api.fonts.refresh());
          if (list) {
            this.state.fonts = list;
            this.render();
            toast.success(`已探测到 ${list.filter((f) => f.installed !== false).length} 种字体`);
          }
        });
        return b;
      })(),
    ]));

    pane.appendChild(el('p.text-sm.text-tertiary', {
      style: { marginTop: '16px', lineHeight: '1.7' },
      text: '提示：手写体（如华文行楷、方正舒体）需要系统安装才有。若本机没有，可下载任意 TTF/OTF 字体文件后通过上方按钮导入，导入后立即生效。',
    }));
  }

  async loadFontFace(f) {
    if (!f || !f.url) return;
    try {
      if (document.fonts.check(`16px "${f.probe}"`)) return;
      const face = new FontFace(f.probe, `url("${f.url}")`);
      await face.load();
      document.fonts.add(face);
      if (this.app.reader) this.app.reader.reflow();
    } catch (err) {
      console.warn('[font]', f.label, err);
    }
  }

  async importFonts() {
    const res = await call(this.api.fonts.importDialog());
    if (!res || res.canceled) return;
    if (res.list) this.state.fonts = res.list;

    if (res.imported && res.imported.length) {
      toast.success(`已导入 ${res.imported.length} 个字体`);
      // 预加载以便立即预览
      for (const f of this.state.fonts.filter((x) => x.user)) await this.loadFontFace(f);
    }
    if (res.failed && res.failed.length) {
      toast.error(`${res.failed.length} 个字体导入失败：${res.failed[0].error}`);
    }
    this.render();
    this.bus.emit('fonts:changed');
  }

  /* ======================== 4. 翻页与自动 ======================== */

  renderPaging(pane) {
    this.paneHeader(pane, '翻页与自动', '翻页模式和滚动模式可以随时切换，阅读位置会自动保持连续。');

    this.segmentRow(pane, '阅读模式', '翻页像纸质书，滚动像网页', 'pageMode', [
      { value: 'page', label: '左右翻页', icon: 'pages' },
      { value: 'scroll', label: '上下滑动', icon: 'scroll' },
    ], () => {
      if (this.app.reader) {
        this.app.reader.pauseAllAuto();
        this.app.reader.applyModeLayout({ ratio: this.app.reader.ratio });
        this.app.renderTitlebar();
      }
    });

    this.segmentRow(pane, '翻页动画', '仿真翻页更接近真实书页', 'pageAnimation', [
      { value: 'slide', label: '平滑位移' },
      { value: 'flip', label: '仿真翻页' },
      { value: 'fade', label: '淡入淡出' },
      { value: 'none', label: '无动画' },
    ], () => this.app.reader && this.app.reader.applyAnimationClass());

    this.sliderRow(pane, '动画时长', '80 - 700 ms，太长会显得拖沓', 'pageAnimationDuration', 80, 700, 20, 'ms',
      null, (v) => $('#reader').style.setProperty('--page-dur', v + 'ms'));

    pane.appendChild(el('div', { style: { height: '24px' } }));

    // 自动翻页
    this.row(pane, '自动翻页', '按固定间隔自动翻页，适合边看边做别的事', 'autoTurnEnabled',
      (() => {
        const s = this.state.settings;
        const sw = el('button.switch', { class: s.autoTurnEnabled ? 'is-on' : '', type: 'button' });
        sw.addEventListener('click', () => {
          const next = !sw.classList.contains('is-on');
          sw.classList.toggle('is-on', next);
          this.patch({ autoTurnEnabled: next });
          if (this.app.reader) {
            if (next) {
              this.app.reader.autoTurner.interval = this.state.settings.autoTurnInterval || 20;
              this.app.reader.autoTurner.start();
              this.app.reader.renderFabs();
              toast(`自动翻页已开启 · 每 ${this.state.settings.autoTurnInterval} 秒一页`);
            } else {
              this.app.reader.autoTurner.stop();
              this.app.reader.renderFabs();
              toast('已停止自动翻页');
            }
          }
        });
        return sw;
      })()
    );

    this.sliderRow(pane, '自动翻页间隔', '每多少秒翻一页', 'autoTurnInterval', 3, 120, 1, '秒', null, (v) => {
      if (this.app.reader && this.app.reader.autoTurner) this.app.reader.autoTurner.setInterval_(v);
    });

    // 自动滚动
    this.sliderRow(pane, '自动滚动速度', '像提词器一样缓缓向下滑，数值越小越慢', 'scrollSpeed', 6, 200, 2, 'px/秒', null, (v) => {
      if (this.app.reader && this.app.reader.scroller) this.app.reader.scroller.setSpeed(v);
    });

    pane.appendChild(el('p.text-sm.text-tertiary', {
      style: { marginTop: '18px', lineHeight: '1.7' },
      text: '自动滚动仅在「上下滑动」模式下生效。在翻页模式下点击自动滚动按钮时，苍穹会自动切换到滚动模式。鼠标移入正文会自动暂停，移出约 2 秒后继续。',
    }));
  }

  /* ======================== 5. 摸鱼模式 ======================== */

  renderBoss(pane) {
    this.paneHeader(pane, '摸鱼模式', '一键把阅读界面伪装成工作软件。所有伪装界面均已预生成，切换发生在毫秒级。');

    // 热键状态
    const st = this.bossState || {};
    const hotkeyDisplay = el('div.hotkey-display', {
      text: st.registeredHotkey || st.hotkey || 'Alt+`',
    });

    const hotkeyWrap = el('div.hotkey-input', {}, [
      hotkeyDisplay,
      (() => {
        const b = el('button.btn.btn--ghost.btn--sm', { text: '重新录制' });
        b.addEventListener('click', () => this.recordHotkey(hotkeyDisplay));
        return b;
      })(),
    ]);

    this.row(pane, '老板键', '窗口失焦时也能触发，这是能瞬间摸鱼的前提', hotkeyWrap);

    if (st.hotkeyOk === false && st.hotkeyError) {
      pane.appendChild(el('div', {
        style: {
          padding: '10px 14px',
          borderRadius: '8px',
          background: 'color-mix(in srgb, var(--c-warning) 14%, transparent)',
          color: 'var(--c-warning)',
          fontSize: '12.5px',
          lineHeight: '1.6',
          marginBottom: '10px',
        },
        text: `⚠ ${st.hotkeyError}`,
      }));
    }

    // 形态
    this.segmentRow(pane, '呈现形态', '正方形迷你框最隐蔽，伪装界面更像在工作', 'bossStyle', [
      { value: 'square', label: '正方形迷你框', icon: 'grid' },
      { value: 'normal', label: '完整伪装窗口', icon: 'layout' },
      { value: 'ghost', label: '隐身模式', icon: 'eyeOff' },
    ], () => this.applyBossOptions());

    // 伪装界面选择
    const fakeGrid = el('div.fake-grid', { style: { width: '100%' } });
    BossModes().forEach((m) => {
      const card = el('button.fake-card', {
        class: this.state.settings.bossMode === m.key ? 'is-active' : '',
      }, [
        el('span.fake-card__icon', { text: m.label.slice(0, 1) }),
        el('span.fake-card__name', { text: m.label }),
        el('span.fake-card__desc', { text: m.desc }),
      ]);
      card.addEventListener('click', () => {
        this.patch({ bossMode: m.key }, { layout: false });
        this.applyBossOptions();
        this.render();
      });
      fakeGrid.appendChild(card);
    });
    this.row(pane, '伪装界面', null, fakeGrid);

    // 迷你框预览
    const size = this.state.settings.miniBoxSize || 300;
    const preview = el('div.minibox-preview', {}, [
      el('div.minibox-preview__bar'),
      el('div.minibox-preview__text', {
        html: `<p>夜色像一层薄薄的墨，慢慢浸透了整条巷子。他站在门口，没有立刻进去。</p>
               <p>"你来了。"屋里的人说，声音很轻。</p>
               <p>风从巷口吹过来，带着一点雨前的潮湿气。</p>`,
      }),
    ]);
    this.row(pane, '迷你框预览', `当前边长 ${size}px · 只有文字，无选项、无边框`, preview);

    this.sliderRow(pane, '迷你框尺寸', '正方形边长', 'miniBoxSize', 180, 520, 10, 'px',
      null, () => { this.applyBossOptions(); this.render(); });

    pane.appendChild(el('div', { style: { height: '20px' } }));

    this.switchRow(pane, '窗口置顶', '切换后仍浮在其他窗口之上，便于继续偷看', 'bossAlwaysOnTop',
      () => this.applyBossOptions());
    this.switchRow(pane, '自动静音', '切换时静音，避免声音暴露', 'bossMute');
    this.switchRow(pane, '隐藏任务栏图标', '任务栏中不显示苍穹，进一步降低被发现概率', 'bossTaskbarHidden',
      () => this.applyBossOptions());

    pane.appendChild(el('div', { style: { height: '20px' } }));

    pane.appendChild(el('div.flex.gap-2', { style: { flexWrap: 'wrap' } }, [
      (() => {
        const b = el('button.btn.btn--solid', { html: icon('ghost', 15) + '<span>立即试用摸鱼模式</span>' });
        b.addEventListener('click', () => {
          this.applyBossOptions();
          this.app.boss.enter();
        });
        return b;
      })(),
      (() => {
        const b = el('button.btn.btn--ghost', { html: icon('eye', 15) + '<span>预览伪装界面</span>' });
        b.addEventListener('click', async () => {
          await call(this.api.boss.preview(this.state.settings.bossMode), { silent: true });
          toast('正在预览，双击窗口顶部区域可退出', { duration: 2600 });
        });
        return b;
      })(),
    ]));

    /* —— 退出方式一览：这是"进得去出不来"的直接解药 —— */
    const st2 = this.bossState || {};
    const exits = [
      ['界面按钮', '鼠标移到迷你框上，点右上角的 ×', true],
      ['退出键', st2.escapeAccel ? `按 ${st2.escapeAccel} 立即退出` : '按 Esc（若被系统占用则不可用）', !!st2.escapeExit],
      ['辅助切换键', `按 ${st2.alternateToggle || 'Ctrl+Alt+Q'} 可在摸鱼与阅读间来回切换`, st2.alternateToggleOk !== false],
      ['老板键', `再按一次 ${st2.registeredHotkey || st2.hotkey || 'Alt+`'} 即可切回`, st2.hotkeyOk !== false],
      ['强制恢复', `任何情况下按 ${st2.restoreFallback || 'Ctrl+Shift+Alt+R'} 都能退出`, true],
      ['右键', '在迷你框内点右键直接退出', true],
    ];

    const exitWrap = el('div', { style: { width: '100%' } });
    exits.forEach(([name, desc, ok]) => {
      exitWrap.appendChild(el('div.kv', {}, [
        el('span.kv__k', {
          style: { width: '96px', color: ok ? 'var(--c-accent)' : 'var(--tx-tertiary)' },
          text: (ok ? '✓ ' : '× ') + name,
        }),
        el('span.kv__v.text-sm.text-secondary', { text: desc }),
      ]));
    });
    this.row(pane, '如何退出摸鱼模式', '共 6 条独立通道，任意一条可用即可退出', exitWrap);

    if (st2.hotkeyOk === false) {
      pane.appendChild(el('div', {
        style: {
          padding: '10px 14px',
          borderRadius: '8px',
          background: 'color-mix(in srgb, var(--c-warning) 12%, transparent)',
          color: 'var(--c-warning)',
          fontSize: '12.5px',
          lineHeight: '1.7',
          marginTop: '12px',
        },
        text: `当前老板键 ${st2.hotkey || ''} 注册失败（${st2.hotkeyError || '被其他程序占用'}）。`
            + `退出摸鱼请用 ${st2.escapeAccel || 'Esc'} 或 ${st2.alternateToggle || 'Ctrl+Alt+Q'}，`
            + `也可以把鼠标移到迷你框上点右上角的 ×。`,
      }));
    }
  }

  applyBossOptions() {
    const s = this.state.settings;
    call(this.api.boss.apply({
      mode: s.bossMode,
      style: s.bossStyle,
      opacity: s.bossOpacity,
      alwaysOnTop: s.bossAlwaysOnTop,
      mute: s.bossMute,
      miniBoxSize: s.miniBoxSize,
    }), { silent: true }).then((st) => {
      if (st) this.bossState = st;
    });
    if (this.app.boss) {
      this.app.boss.mode = s.bossMode;
      this.app.boss.style = s.bossStyle;
    }
  }

  /** 录制热键 */
  recordHotkey(display) {
    display.classList.add('is-recording');
    display.textContent = '请按下组合键…';

    const parts = [];
    const cleanup = () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onUp, true);
      display.classList.remove('is-recording');
    };

    let captured = '';
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        cleanup();
        display.textContent = this.state.settings.bossHotkey || 'Alt+`';
        return;
      }

      const mods = [];
      if (e.ctrlKey) mods.push('Control');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Super');

      const key = normalizeKey(e);
      // 仅按修饰键时不提交
      if (!key) return;
      if (!mods.length && ['F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12'].indexOf(key) === -1) {
        display.textContent = '需包含 Ctrl / Alt / Shift';
        return;
      }

      captured = [...mods, key].join('+');
      display.textContent = captured;

      // 等按键松起再提交，避免与系统冲突
      const submit = async () => {
        cleanup();
        document.removeEventListener('keyup', submit, true);
        const res = await call(this.api.boss.setHotkey(captured), { silent: true });
        if (res) {
          this.bossState = res.state || {};
          if (res.ok) toast.success(`老板键已设为 ${captured}`);
          else toast.error(res.error || '该组合键被占用，请换一个', { duration: 3600 });
          this.patch({ bossHotkey: captured }, { layout: false });
          this.render();
        }
      };
      document.addEventListener('keyup', submit, true);
    };

    document.addEventListener('keydown', onKey, true);
  }

  /* ======================== 6. 数据与存储 ======================== */

  renderData(pane) {
    this.paneHeader(pane, '数据与存储', '苍穹完全离线运行，所有数据都保存在本机，不会上传到任何服务器。');

    const info = this.appInfo || {};

    pane.appendChild(el('div.about-box', { style: { marginBottom: '24px' } }, [
      el('div.kv', {}, [el('span.kv__k', { text: '数据目录' }), el('span.kv__v', { text: info.userData || '—' })]),
      el('div.kv', {}, [el('span.kv__k', { text: '书架数量' }), el('span.kv__v', { text: `${this.state.books.length} 本` })]),
      el('div.kv', {}, [
        el('span.kv__k', { text: '占用空间' }),
        el('span.kv__v', { text: `${fmtMb(this.state.books.reduce((a, b) => a + (b.size || 0), 0))} MB（书籍文件本体不计入）` }),
      ]),
    ]));

    pane.appendChild(el('div.flex.gap-2', { style: { flexWrap: 'wrap', marginBottom: '24px' } }, [
      (() => {
        const b = el('button.btn.btn--ghost', { html: icon('folder', 15) + '<span>打开数据目录</span>' });
        b.addEventListener('click', () => call(this.api.shell.openPath(info.userData || ''), { silent: true }));
        return b;
      })(),
      (() => {
        const b = el('button.btn.btn--ghost', { html: icon('shield', 15) + '<span>检查文件有效性</span>' });
        b.addEventListener('click', async () => {
          const missing = await call(this.api.books.validate());
          await this.app.reloadBooks();
          if (!missing || !missing.length) toast.success('所有书籍文件均正常');
          else toast.error(`${missing.length} 本书的源文件已失效`, { duration: 3600 });
        });
        return b;
      })(),
      (() => {
        const b = el('button.btn.btn--ghost', { html: icon('refresh', 15) + '<span>重置全部排版设置</span>' });
        b.addEventListener('click', async () => {
          const ok = await call(this.api.dialog.confirm({
            title: '重置设置',
            message: '确定要把排版、主题等设置恢复为默认值吗？',
            detail: '不会影响书架与阅读记录。',
            buttons: ['取消', '重置'],
          }), { silent: true });
          if (!ok) return;
          const res = await call(this.api.settings.reset('all'));
          if (res) {
            this.state.settings = res;
            this.app.theme.settings = res;
            this.app.theme.apply();
            if (this.app.reader) this.app.reader.reflow();
            this.app.settingsView.render();
            toast.success('已恢复默认设置');
          }
        });
        return b;
      })(),
    ]));

    pane.appendChild(el('h3', { text: '阅读记录', style: { fontSize: '14px', margin: '0 0 12px', fontWeight: '500' } }));

    const records = this.state.recent.slice(0, 6);
    if (!records.length) {
      pane.appendChild(el('p.text-sm.text-tertiary', { text: '还没有阅读记录。' }));
    } else {
      const wrap = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', width: '100%' } });
      records.forEach((r) => {
        const pct = Math.round((r.progress.ratio || 0) * 100);
        const row = el('div.flex.items-center.gap-3', {
          style: { padding: '10px 0', borderBottom: '1px solid var(--bd-subtle)' },
        }, [
          el('span', { text: r.book.title, style: { flex: '1', fontSize: '13.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }),
          el('span.text-sm.text-tertiary', { text: `第 ${(r.progress.chapterIndex || 0) + 1} 章 · ${pct}%` }),
          (() => {
            const b = el('button.btn.btn--sm.btn--danger', { text: '清除' });
            b.addEventListener('click', async () => {
              await call(this.api.progress.clear(r.book.id));
              await this.app.reloadBooks();
              this.render();
              toast.success('已清除');
            });
            return b;
          })(),
        ]);
        wrap.appendChild(row);
      });
      this.row(pane, '最近阅读', '清除后该书将从「继续阅读」中移除', wrap);
    }
  }

  /* ======================== 7. 关于 ======================== */

  renderAbout(pane) {
    const info = this.appInfo || {};
    this.paneHeader(pane, '关于苍穹', 'Firmament Reader —— 一个能安静读完一本书的桌面软件。');

    pane.appendChild(el('div.about-box', {}, [
      el('div.flex.items-center.gap-4', {}, [
        el('div.about-logo', { text: '苍' }),
        el('div', {}, [
          el('div', { text: '苍穹', style: { fontSize: '20px', fontWeight: '500' } }),
          el('div.text-sm.text-tertiary', { text: 'Firmament Reader' }),
        ]),
      ]),
      el('div', {}, [
        el('div.kv', {}, [el('span.kv__k', { text: '版本' }), el('span.kv__v', { text: info.version || '1.0.0' })]),
        el('div.kv', {}, [el('span.kv__k', { text: '支持格式' }), el('span.kv__v', { text: 'TXT（自动识别编码）· EPUB（EPUB2 / EPUB3）' })]),
        el('div.kv', {}, [el('span.kv__k', { text: '运行环境' }), el('span.kv__v', { text: `Electron ${info.electron || '—'} · Chromium ${info.chrome || '—'}` })]),
        el('div.kv', {}, [el('span.kv__k', { text: '平台' }), el('span.kv__v', { text: info.platform === 'win32' ? 'Windows' : info.platform === 'darwin' ? 'macOS' : 'Linux' })]),
        el('div.kv', {}, [el('span.kv__k', { text: '网络' }), el('span.kv__v', { text: '完全离线 · 无账号 · 无广告 · 数据仅存本机' })]),
      ]),
    ]));

    pane.appendChild(el('h3', { text: '键盘快捷键', style: { fontSize: '14px', margin: '26px 0 12px', fontWeight: '500' } }));

    const shortcuts = [
      ['Ctrl + O', '导入小说文件'],
      ['Ctrl + F', '全文搜索（阅读中）'],
      ['Ctrl + T', '打开目录'],
      ['Ctrl + B', '添加 / 取消书签'],
      ['Ctrl + ,', '打开阅读设置'],
      ['Ctrl + D', '日间 / 夜间快速切换'],
      ['Ctrl + = / -', '放大 / 缩小字号'],
      ['← → ↑ ↓', '翻页（翻页模式）/ 滚动（滚动模式）'],
      ['Space / PageDown', '下一页'],
      ['Home / End', '跳到全书开头 / 结尾'],
      ['F11', '全屏切换'],
      ['Esc', '逐层退出（抽屉 → 自动模式 → 书架）'],
      ['双击标题栏', '最大化 / 还原窗口'],
      ['Alt + `', '摸鱼模式（可在设置中修改）'],
      ['Ctrl+Shift+Alt+R', '强制退出摸鱼模式（兜底）'],
    ];

    const wrap = el('div', { style: { width: '100%' } });
    shortcuts.forEach(([k, d]) => {
      wrap.appendChild(el('div.kv', {}, [
        el('span.kv__k', {
          text: k,
          style: { fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--tx-primary)', width: '170px' },
        }),
        el('span.kv__v.text-sm.text-secondary', { text: d }),
      ]));
    });
    this.row(pane, '快捷键一览', null, wrap);
  }
}

/* ======================== 工具 ======================== */

function normalizeKey(e) {
  const k = e.key;
  if (!k) return '';
  if (['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'Dead'].includes(k)) return '';
  const map = {
    ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Escape: 'Esc', Enter: 'Return', '+': 'Plus', '-': 'Minus', '=': 'Equal',
    '`': '`', '~': '`', Backquote: '`', PageUp: 'PageUp', PageDown: 'PageDown',
    Home: 'Home', End: 'End', Insert: 'Insert', Delete: 'Delete', Tab: 'Tab',
  };
  if (map[k]) return map[k];
  if (k.length === 1) return k.toUpperCase();
  return k;
}

function fmtMb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

/** 伪装模式清单（与 BossView 保持一致） */
function BossModes() {
  return [
    { key: 'fake-word', label: 'Word 文档', desc: '会议纪要，最不引人注意' },
    { key: 'fake-excel', label: 'Excel 表格', desc: '带行列号与公式栏' },
    { key: 'fake-code', label: 'VS Code', desc: '带语法高亮的编辑器' },
    { key: 'fake-mail', label: 'Outlook 邮件', desc: '三栏邮件客户端' },
    { key: 'mini-text', label: '纯文字迷你框', desc: '只有一个方框的正文' },
  ];
}