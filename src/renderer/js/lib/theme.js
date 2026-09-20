/**
 * 主题 / 皮肤 / 背景 应用层。
 * 所有视觉状态都通过 CSS 变量下发，避免逐个组件改样式。
 */

export const THEMES = [
  { key: 'day', label: '日间', dark: false, swatch: ['#ffffff', '#f2f1ee', '#23211f'] },
  { key: 'paper', label: '米黄', dark: false, swatch: ['#faf5ec', '#efe8dc', '#2b2620'] },
  { key: 'eyecare', label: '护眼绿', dark: false, swatch: ['#e6f2e7', '#cce8cf', '#1f3025'] },
  { key: 'sepia', label: '羊皮纸', dark: false, swatch: ['#f6edda', '#e9dfc9', '#2e2619'] },
  { key: 'night', label: '夜间', dark: true, swatch: ['#191c21', '#101215', '#d6d4d0'] },
  { key: 'mint', label: '墨青', dark: true, swatch: ['#14211f', '#0e1a19', '#ccd8d5'] },
];

/** 背景纹理：全部用 CSS 生成，不引入图片资源 */
export const TEXTURES = [
  { key: 'none', label: '无', css: null },
  {
    key: 'paper',
    label: '纸纹',
    css: `repeating-linear-gradient(0deg, rgba(120,96,60,.05) 0 1px, transparent 1px 3px),
          repeating-linear-gradient(90deg, rgba(120,96,60,.035) 0 1px, transparent 1px 4px)`,
    size: 'auto',
    opacity: 0.5,
  },
  {
    key: 'linen',
    label: '布纹',
    css: `repeating-linear-gradient(45deg, rgba(90,80,70,.045) 0 2px, transparent 2px 5px),
          repeating-linear-gradient(-45deg, rgba(90,80,70,.035) 0 2px, transparent 2px 5px)`,
    size: 'auto',
    opacity: 0.55,
  },
  {
    key: 'dots',
    label: '点阵',
    css: `radial-gradient(circle, rgba(100,90,80,.10) 1px, transparent 1.2px)`,
    size: '20px 20px',
    opacity: 0.7,
  },
  {
    key: 'grid',
    label: '方格',
    css: `repeating-linear-gradient(0deg, rgba(90,100,110,.055) 0 1px, transparent 1px 26px),
          repeating-linear-gradient(90deg, rgba(90,100,110,.055) 0 1px, transparent 1px 26px)`,
    size: 'auto',
    opacity: 0.75,
  },
  {
    key: 'craft',
    label: '牛皮纸',
    css: `radial-gradient(ellipse at 22% 18%, rgba(150,110,60,.09) 0 22%, transparent 55%),
          radial-gradient(ellipse at 78% 74%, rgba(130,92,48,.08) 0 20%, transparent 52%),
          repeating-linear-gradient(76deg, rgba(140,100,55,.028) 0 3px, transparent 3px 8px)`,
    size: 'auto',
    opacity: 0.85,
  },
  {
    key: 'cloud',
    label: '云纹',
    css: `radial-gradient(circle at 12% 26%, rgba(120,130,150,.07) 0 16%, transparent 34%),
          radial-gradient(circle at 74% 62%, rgba(120,130,150,.06) 0 20%, transparent 40%),
          radial-gradient(circle at 40% 88%, rgba(120,130,150,.05) 0 14%, transparent 30%)`,
    size: '360px 360px',
    opacity: 0.9,
  },
  {
    key: 'bamboo',
    label: '竹影',
    css: `repeating-linear-gradient(94deg, rgba(80,120,80,.05) 0 2px, transparent 2px 34px),
          radial-gradient(circle at 20% 70%, rgba(80,120,80,.05) 0 8%, transparent 20%)`,
    size: 'auto',
    opacity: 0.8,
  },
  {
    key: 'star',
    label: '星空',
    css: `radial-gradient(circle at 8% 12%, rgba(160,180,220,.5) .8px, transparent 1.4px),
          radial-gradient(circle at 32% 58%, rgba(160,180,220,.42) .7px, transparent 1.2px),
          radial-gradient(circle at 64% 24%, rgba(160,180,220,.46) .9px, transparent 1.5px),
          radial-gradient(circle at 86% 74%, rgba(160,180,220,.38) .6px, transparent 1.1px),
          radial-gradient(circle at 48% 88%, rgba(160,180,220,.4) .7px, transparent 1.2px),
          radial-gradient(circle at 18% 82%, rgba(160,180,220,.34) .6px, transparent 1.1px),
          radial-gradient(circle at 74% 46%, rgba(160,180,220,.44) .8px, transparent 1.3px)`,
    size: '170px 170px',
    opacity: 1,
  },
  {
    key: 'leather',
    label: '皮革',
    css: `repeating-radial-gradient(circle at 26% 32%, rgba(90,60,35,.05) 0 3px, transparent 3px 7px),
          repeating-radial-gradient(circle at 72% 68%, rgba(90,60,35,.04) 0 3px, transparent 3px 8px)`,
    size: 'auto',
    opacity: 0.7,
  },
  {
    key: 'snow',
    label: '雪纹',
    css: `radial-gradient(circle at 30% 30%, rgba(200,215,230,.16) 0 3%, transparent 8%),
          radial-gradient(circle at 70% 70%, rgba(200,215,230,.13) 0 3%, transparent 8%)`,
    size: '280px 280px',
    opacity: 0.85,
  },
  {
    key: 'ink',
    label: '水墨',
    css: `radial-gradient(ellipse 40% 24% at 18% 30%, rgba(40,50,60,.055) 0 40%, transparent 72%),
          radial-gradient(ellipse 32% 18% at 78% 68%, rgba(40,50,60,.045) 0 40%, transparent 72%),
          radial-gradient(ellipse 26% 14% at 52% 88%, rgba(40,50,60,.04) 0 40%, transparent 70%)`,
    size: '520px 520px',
    opacity: 0.9,
  },
];

export const SKINS = [
  { key: 'minimal', label: '极简', desc: '通透留白，控件淡出' },
  { key: 'skeuo', label: '拟物', desc: '纸感书页，木质书架' },
];

export class ThemeManager {
  constructor(settings) {
    this.settings = settings || {};
    this.root = document.documentElement;
    this.bgEl = null;
    this.listeners = new Set();
  }

  bind(bgEl) {
    this.bgEl = bgEl;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(key) {
    this.listeners.forEach((fn) => {
      try { fn(key, this.settings); } catch (_) {}
    });
  }

  isDark() {
    const t = THEMES.find((x) => x.key === this.settings.theme);
    return t ? t.dark : false;
  }

  /** 应用全部视觉设置 */
  apply(settings) {
    if (settings) this.settings = settings;
    const s = this.settings;

    this.root.setAttribute('data-theme', s.theme || 'day');
    this.root.setAttribute('data-skin', s.skin || 'minimal');
    this.root.setAttribute('data-contrast', s.highContrast ? 'high' : 'normal');

    this.applyTypography(s);
    this.applyBackground(s);
    this.applyBrightness(s);
  }

  applyTypography(s) {
    const r = this.root.style;
    r.setProperty('--reader-font-size', (s.fontSize || 19) + 'px');
    r.setProperty('--reader-line-height', String(s.lineHeight || 1.8));
    r.setProperty('--reader-letter-spacing', (s.letterSpacing || 0) + 'em');
    r.setProperty('--reader-font-weight', String(s.fontWeight || 400));
    r.setProperty('--reader-para-spacing', (s.paragraphSpacing != null ? s.paragraphSpacing : 0.9) + 'em');
    r.setProperty('--reader-para-indent', (s.paragraphIndent != null ? s.paragraphIndent : 2) + 'em');
    r.setProperty('--reader-text-align', s.textAlign || 'justify');

    r.setProperty('--reader-mt', (s.marginTop != null ? s.marginTop : 64) + 'px');
    r.setProperty('--reader-mb', (s.marginBottom != null ? s.marginBottom : 64) + 'px');
    r.setProperty('--reader-ml', (s.marginLeft != null ? s.marginLeft : 88) + 'px');
    r.setProperty('--reader-mr', (s.marginRight != null ? s.marginRight : 88) + 'px');

    // 正文最大宽度：0 表示不限宽。
    // ⚠ 不限宽时必须写 none，不能写 0px —— 写 0px 会让 max-width 生效为 0，
    //   容器宽度塌成 0，中文每字一行（滚动模式会彻底垮掉）。
    if (s.contentWidth && s.contentWidth > 400) {
      r.setProperty('--reader-max-width', s.contentWidth + 'px');
    } else {
      r.setProperty('--reader-max-width', 'none');
    }

    const ff = s.fontFamily || '';
    r.setProperty('--font-reading', ff || '"Microsoft YaHei", "PingFang SC", sans-serif');
  }

  applyBackground(s) {
    const tex = TEXTURES.find((t) => t.key === (s.background || 'none'));
    if (this.bgEl) {
      const bgTex = this.bgEl.querySelector('.reader-bg--tex') || this.bgEl;
      if (tex && tex.css) {
        bgTex.style.backgroundImage = tex.css;
        bgTex.style.backgroundSize = tex.size || 'auto';
        bgTex.style.setProperty('--bg-tex-opacity', String((tex.opacity != null ? tex.opacity : 1) * (s.bgOpacity != null ? s.bgOpacity : 0.18) * 3));
        bgTex.classList.add('is-on');
      } else {
        bgTex.style.backgroundImage = 'none';
        bgTex.classList.remove('is-on');
      }
    }
  }

  applyBrightness(s) {
    const b = s.brightness != null ? s.brightness : 1;
    const dim = this.root.querySelector ? null : null;
    // 亮度通过叠加黑色实现（>1 无法提亮，用 filter 处理）
    this.root.style.setProperty('--reader-brightness', String(b));
  }

  /** 夜间/白天快捷切换（在日间与夜间之间来回） */
  toggleDark() {
    const dark = this.isDark();
    const next = dark ? (this.settings.lastLightTheme || 'day') : 'night';
    if (!dark) this.settings.lastLightTheme = this.settings.theme;
    this.settings.theme = next;
    this.apply();
    this.emit('theme');
    return next;
  }

  set(key, value) {
    this.settings[key] = value;
    this.apply();
    this.emit(key);
  }

  static themeSwatch(theme) {
    const css = [];
    for (const t of THEMES) {
      if (t.key === theme) {
        return t.swatch.map((c) => `<i style="background:${c}"></i>`).join('');
      }
    }
    return '';
  }

  /** 依据当前主题推导「深色/浅色」，供 canvas 与图片处理使用 */
  prefersDark() {
    return this.isDark();
  }
}