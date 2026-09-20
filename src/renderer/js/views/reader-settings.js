import { $, $$, el, clear, esc, clamp, delegate, debounce } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { toast } from '../lib/toast.js';
import { THEMES, TEXTURES, SKINS } from '../lib/theme.js';

/**
 * 阅读设置抽屉。
 * 挂载到 ReaderView 实例上（injectReaderSettings(reader)）。
 *
 * 设计要点：
 *   - 所有参数改动 → 立即写 CSS 变量 → 立即重排 → 防抖持久化
 *   - 字体列表分组展示，并标注「未安装」的字体，避免用户点了没反应却不知道为什么
 */

export function injectReaderSettings(reader) {
  const app = reader.app;
  const state = reader.state;

  const settings = () => state.settings;

  /** 统一提交：改设置 → 应用 → 重排 → 存盘 */
  const commit = (patch, opts) => {
    const o = opts || {};
    const affectsLayout = o.layout !== false;
    app.patchSettings(patch, true);
    if (affectsLayout) reader.reflow();
    app.saveSettings(patch);
    if (o.toast) toast(o.toast, { duration: 1200 });
  };

  function mount() {
    const host = $('#readerSettingsBody');
    if (!host) return;
    clear(host);
    const s = settings();

    /* —— 快捷行：日夜切换 + 全屏 —— */
    host.appendChild(el('div.drawer__section', {}, [
      el('div.flex.gap-2', {}, [
        quickBtn(icon('sun', 15) + '<span>日间</span>', () => {
          commit({ theme: 'day' });
          mount();
        }, s.theme === 'day'),
        quickBtn(icon('moon', 15) + '<span>夜间</span>', () => {
          commit({ theme: 'night' });
          mount();
        }, s.theme === 'night'),
        quickBtn(icon('eye', 15) + '<span>护眼</span>', () => {
          commit({ theme: 'eyecare' });
          mount();
        }, s.theme === 'eyecare'),
      ]),
    ]));

    /* —— 全部主题 —— */
    host.appendChild(el('div.drawer__section', {}, [
      el('div.drawer__legend', { text: '主题' }),
      el('div.theme-row', {}, THEMES.map((t) => themeChip(t, s.theme, () => {
        commit({ theme: t.key });
        mount();
      }))),
    ]));

    /* —— 皮肤 —— */
    host.appendChild(el('div.drawer__section', {}, [
      el('div.drawer__legend', { text: '皮肤' }),
      el('div.skin-row', {}, SKINS.map((sk) => skinChip(sk, s.skin, () => {
        commit({ skin: sk.key }, { layout: false });
        mount();
      }))),
    ]));

    /* —— 字体 —— */
    host.appendChild(el('div.drawer__section', {}, [
      el('div.drawer__legend', { text: '字体' }),
      fontPicker(s, () => mount()),
    ]));

    /* —— 排版滑块 —— */
    host.appendChild(el('div.drawer__section', {}, [
      el('div.drawer__legend', { text: '排版' }),
      slider('字号', s.fontSize, 12, 40, 1, 'px', (v) => commit({ fontSize: v })),
      slider('行间距', s.lineHeight, 1.1, 3.0, 0.05, '', (v) => commit({ lineHeight: v }), (v) => v.toFixed(2)),
      slider('字间距', s.letterSpacing, -0.04, 0.30, 0.01, 'em', (v) => commit({ letterSpacing: v }), (v) => v.toFixed(2)),
      slider('段间距', s.paragraphSpacing, 0, 2.4, 0.1, 'em', (v) => commit({ paragraphSpacing: v }), (v) => v.toFixed(1)),
      slider('首行缩进', s.paragraphIndent, 0, 4, 0.5, '字', (v) => commit({ paragraphIndent: v }), (v) => v.toFixed(1)),
      el('div.field', {}, [
        el('label.field__label', {}, [
          el('span', { text: '对齐方式' }),
        ]),
        segmentControl([
          { key: 'justify', label: '两端' },
          { key: 'left', label: '左齐' },
        ], s.textAlign || 'justify', (v) => commit({ textAlign: v })),
      ]),
      el('div.field', {}, [
        el('label.field__label', {}, el('span', { text: '字重' })),
        segmentControl([
          { key: 300, label: '细' },
          { key: 400, label: '常规' },
          { key: 500, label: '中' },
          { key: 600, label: '粗' },
        ], s.fontWeight || 400, (v) => commit({ fontWeight: Number(v) })),
      ]),
    ]));

    /* —— 页边距 —— */
    host.appendChild(el('div.drawer__section', {}, [
      el('div.drawer__legend', { text: '页边距' }),
      slider('上下', s.marginTop, 16, 200, 4, 'px', (v) => commit({ marginTop: v, marginBottom: v })),
      slider('左右', s.marginLeft, 16, 320, 4, 'px', (v) => commit({ marginLeft: v, marginRight: v })),
      slider('正文宽度', s.contentWidth || 0, 0, 1200, 20, 'px',
        (v) => commit({ contentWidth: v }),
        (v) => (v <= 400 ? '自适应' : v + 'px')),
    ]));

    /* —— 背景 —— */
    host.appendChild(el('div.drawer__section', {}, [
      el('div.drawer__legend', { text: '背景纹理' }),
      el('div.bg-grid', {}, TEXTURES.map((t) => bgChip(t, s.background, () => {
        commit({ background: t.key }, { layout: false });
        app.theme.applyBackground(settings());
        mount();
      }))),
      el('div.field', { style: { marginTop: '12px' } }, [
        el('label.field__label', {}, [
          el('span', { text: '纹理浓度' }),
          el('span.field__value', { text: Math.round((s.bgOpacity || 0.18) * 100) + '%' }),
        ]),
        rangeInput(s.bgOpacity || 0.18, 0, 1, 0.02, (v) => {
          app.patchSettings({ bgOpacity: v }, true);
          app.theme.applyBackground(settings());
          app.saveSettings({ bgOpacity: v });
        }),
      ]),
    ]));

    /* —— 显示效果 —— */
    host.appendChild(el('div.drawer__section', {}, [
      el('div.drawer__legend', { text: '显示' }),
      slider('亮度', s.brightness != null ? s.brightness : 1, 0.4, 1.4, 0.05, '',
        (v) => {
          app.patchSettings({ brightness: v }, true);
          applyBrightness(v);
          app.saveSettings({ brightness: v });
        }, (v) => Math.round(v * 100) + '%'),
    ]));

    /* —— 翻页 —— */
    host.appendChild(el('div.drawer__section', {}, [
      el('div.drawer__legend', { text: '翻页方式' }),
      el('div.segment', { style: { width: '100%' } }, [
        segItem('翻页', 'pages', s.pageMode !== 'scroll', () => {
          reader.setPageMode('page');
          mount();
        }),
        segItem('上下滑动', 'scroll', s.pageMode === 'scroll', () => {
          reader.setPageMode('scroll');
          mount();
        }),
      ]),

      s.pageMode !== 'scroll' ? el('div.field', { style: { marginTop: '14px' } }, [
        el('label.field__label', {}, el('span', { text: '翻页动画' })),
        segmentControl([
          { key: 'slide', label: '平滑' },
          { key: 'flip', label: '仿真' },
          { key: 'fade', label: '淡入' },
          { key: 'none', label: '无' },
        ], s.pageAnimation || 'slide', (v) => {
          commit({ pageAnimation: v }, { layout: false });
          reader.applyAnimationClass();
        }),
        el('div.field', { style: { marginTop: '12px' } }, [
          el('label.field__label', {}, [
            el('span', { text: '动画时长' }),
            el('span.field__value', { text: (s.pageAnimationDuration || 260) + 'ms' }),
          ]),
          rangeInput(s.pageAnimationDuration || 260, 80, 700, 20, (v) => {
            app.patchSettings({ pageAnimationDuration: v }, true);
            $('#reader').style.setProperty('--page-dur', v + 'ms');
            app.saveSettings({ pageAnimationDuration: v });
            const val = host.querySelector('.page-dur-value');
          }),
        ]),
      ]) : null,
    ]));

    /* —— 自动页 —— */
    host.appendChild(el('div.drawer__section', {}, [
      el('div.drawer__legend', { text: '自动阅读' }),

      s.pageMode !== 'scroll' ? el('div', {}, [
        el('div.setting-row.setting-sub', {}, [
          el('div.setting-row__label', {}, [
            el('span.setting-row__name', { text: '自动翻页' }),
            el('span.setting-row__hint', { text: `每 ${s.autoTurnInterval} 秒翻一页` }),
          ]),
          el('div.setting-row__control', {}, [
            switchEl(reader.autoTurner && reader.autoTurner.enabled, (on) => {
              if (on) {
                state.settings.autoTurnInterval = s.autoTurnInterval;
                reader.autoTurner.interval = s.autoTurnInterval;
                reader.autoTurner.start();
                toast(`自动翻页已开启 · 每 ${s.autoTurnInterval} 秒`);
              } else {
                reader.autoTurner.stop();
                toast('已停止自动翻页');
              }
              reader.renderFabs();
              setTimeout(mount, 120);
            }),
          ]),
        ]),
        slider('翻页间隔', s.autoTurnInterval, 3, 120, 1, '秒', (v) => {
          app.patchSettings({ autoTurnInterval: v }, true);
          app.saveSettings({ autoTurnInterval: v });
          if (reader.autoTurner) reader.autoTurner.setInterval_(v);
          const hint = host.querySelector('.setting-sub .setting-row__hint');
          if (hint) hint.textContent = `每 ${v} 秒翻一页`;
        }),
      ]) : null,

      el('div.setting-row.setting-sub', {}, [
        el('div.setting-row__label', {}, [
          el('span.setting-row__name', { text: '自动滚动' }),
          el('span.setting-row__hint', { text: '像提词器一样缓缓向下滑动' }),
        ]),
        el('div.setting-row__control', {}, [
          switchEl(reader.autoscroll, (on) => {
            if (on) reader.toggleAutoScroll();
            else reader.stopAutoScroll(true);
            setTimeout(mount, 120);
          }),
        ]),
      ]),
      slider('滚动速度', s.scrollSpeed, 6, 200, 2, 'px/秒', (v) => {
        app.patchSettings({ scrollSpeed: v }, true);
        app.saveSettings({ scrollSpeed: v });
        reader.scroller.setSpeed(v);
      }),
    ]));

    /* —— 打开完整设置 —— */
    host.appendChild(el('div.drawer__section', {}, [
      el('button.btn.btn--ghost', {
        style: { width: '100%' },
        html: icon('settings', 15) + '<span>打开完整设置</span>',
        onclick: () => {
          reader.closeDrawers();
          app.route('settings');
        },
      }),
    ]));

    applyBrightness(s.brightness != null ? s.brightness : 1);
  }

  /* ======================== 组件构造 ======================== */

  function quickBtn(html, onClick, active) {
    const b = el('button.btn.btn--ghost', {
      class: active ? 'btn--soft' : '',
      style: { flex: '1', gap: '6px' },
      html,
    });
    b.addEventListener('click', onClick);
    return b;
  }

  function themeChip(t, current, onClick) {
    const chip = el('button.theme-chip', { class: t.key === current ? 'is-active' : '', title: t.label }, [
      el('span.theme-chip__swatch', {}, t.swatch.map((c) => el('i', { style: { background: c } }))),
      el('span.theme-chip__name', { text: t.label }),
    ]);
    chip.addEventListener('click', onClick);
    return chip;
  }

  function skinChip(sk, current, onClick) {
    const chip = el('button.skin-chip', {
      class: `${sk.key === current ? 'is-active' : ''} skin-chip--${sk.key}`,
      title: sk.desc,
    }, [
      el('span.skin-chip__demo', {}, [el('i'), el('i'), el('i')]),
      el('span.skin-chip__label', { text: sk.label }),
    ]);
    chip.addEventListener('click', onClick);
    return chip;
  }

  function slider(label, value, min, max, step, unit, onChange, format) {
    const valText = el('span.field__value', {
      text: format ? format(Number(value)) : `${value}${unit}`,
    });
    const input = rangeInput(value, min, max, step, (v) => {
      valText.textContent = format ? format(Number(v)) : `${v}${unit}`;
      onChange(Number(v));
    });
    return el('div.field', { style: { marginBottom: '14px' } }, [
      el('label.field__label', {}, [el('span', { text: label }), valText]),
      input,
    ]);
  }

  function rangeInput(value, min, max, step, onInput) {
    const input = el('input.range', {
      type: 'range',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
    });
    input.addEventListener('input', () => onInput(input.value));
    return input;
  }

  function segmentControl(items, current, onChange) {
    const seg = el('div.segment', { style: { width: '100%' } });
    items.forEach((it) => {
      const b = el('button.segment__item', {
        class: String(it.key) === String(current) ? 'is-active' : '',
        style: { flex: '1', justifyContent: 'center' },
        text: it.label,
      });
      b.addEventListener('click', () => {
        $$('.segment__item', seg).forEach((x) => x.classList.remove('is-active'));
        b.classList.add('is-active');
        onChange(it.key);
      });
      seg.appendChild(b);
    });
    return seg;
  }

  function segItem(label, iconName, active, onClick) {
    const b = el('button.segment__item', {
      class: active ? 'is-active' : '',
      style: { flex: '1', justifyContent: 'center', gap: '6px' },
      html: icon(iconName, 15) + `<span>${label}</span>`,
    });
    b.addEventListener('click', onClick);
    return b;
  }

  function switchEl(on, onChange) {
    const sw = el('button.switch', { class: on ? 'is-on' : '', type: 'button', 'aria-pressed': on ? 'true' : 'false' });
    sw.addEventListener('click', () => {
      const next = !sw.classList.contains('is-on');
      sw.classList.toggle('is-on', next);
      sw.setAttribute('aria-pressed', next ? 'true' : 'false');
      onChange(next);
    });
    return sw;
  }

  function bgChip(t, current, onClick) {
    const isNone = t.key === 'none';
    const chip = el('button.bg-chip', {
      class: `${t.key === current ? 'is-active' : ''} ${isNone ? 'bg-chip--none' : ''}`,
      title: t.label,
      style: !isNone && t.css ? { backgroundImage: t.css, backgroundSize: t.size || 'auto' } : {},
    }, isNone ? [el('span', { text: '无' })] : null);
    chip.addEventListener('click', onClick);
    return chip;
  }

  /** 亮度：通过叠加黑色（暗）+ 提高对比（亮）实现 */
  function applyBrightness(v) {
    const dim = $('#readerDim');
    if (!dim) return;
    const val = Number(v);
    if (val < 1) {
      dim.style.opacity = String(clamp((1 - val) * 0.62, 0, 0.55));
      dim.style.background = '#000';
    } else {
      dim.style.opacity = '0';
    }
    // 提亮：用白色叠加轻微提亮
    const reader = $('#reader');
    if (val > 1) {
      const tint = $('#readerTint');
      tint.style.background = '#ffffff';
      tint.style.opacity = String(clamp((val - 1) * 0.36, 0, 0.22));
      tint.classList.add('is-on');
    } else {
      const tint = $('#readerTint');
      if (tint && !settings().eyeCareLevel) {
        tint.classList.remove('is-on');
        tint.style.opacity = '0';
      }
    }
  }

  /* ======================== 字体选择器 ======================== */

  function fontPicker(s, remount) {
    const current = state.fonts.find((f) => f.family === s.fontFamily) || { label: '跟随主题默认', family: s.fontFamily, group: '系统' };
    const collapsed = { v: true };

    const grid = el('div.font-grid.is-collapsed');
    const currentBtn = el('button.font-picker__current', {
      html: `<span class="font-picker__name" style="font-family:${esc(s.fontFamily || 'inherit')}">${esc(current.label)}</span>`
        + `<span class="font-picker__hint">${state.fonts.length} 种可选</span>`
        + icon('chevronDown', 15),
    });

    const renderList = () => {
      clear(grid);
      const groups = new Map();
      state.fonts.forEach((f) => {
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
        grid.appendChild(el('div.font-group__label', { text: groupName }));
        fonts.forEach((f) => {
          const isActive = f.family === s.fontFamily;
          const missing = f.installed === false;
          const row = el('button.font-option', { class: isActive ? 'is-active' : '' }, [
            el('span.font-option__sample', {
              text: f.label,
              style: { fontFamily: f.family },
            }),
            f.user ? el('span.font-option__tag.font-option__tag--custom', { text: '已导入' }) : null,
            missing ? el('span.font-option__tag.font-option__tag--missing', { text: '未安装' }) : null,
            isActive ? el('span', { html: icon('check', 15), style: { display: 'flex', color: 'var(--c-accent)' } }) : null,
          ]);

          row.addEventListener('click', () => {
            if (missing) {
              toast.error(`本机未安装「${f.label}」，系统会自动回退到相似字体`, { duration: 3400 });
            }
            commit({ fontFamily: f.family });
            if (f.user || f.family.includes('"')) {
              // 用户字体：等字体加载完再重排，避免行高变化造成错位
              loadFontFace(f).then(() => reader.reflow());
            }
            remount();
          });
          grid.appendChild(row);
        });
      }

      // 导入入口
      const importRow = el('button.font-option', { style: { marginTop: '6px', borderTop: '1px solid var(--bd-subtle)' } }, [
        el('span', { html: icon('upload', 16), style: { display: 'flex', color: 'var(--c-accent)' } }),
        el('span.font-option__sample', { text: '导入字体文件…', style: { fontSize: '13px', color: 'var(--c-accent)' } }),
      ]);
      importRow.addEventListener('click', async () => {
        await app.settingsView.importFonts();
        remount();
      });
      grid.appendChild(importRow);
    };

    currentBtn.addEventListener('click', () => {
      collapsed.v = !collapsed.v;
      grid.classList.toggle('is-collapsed', collapsed.v);
      if (!collapsed.v && !grid.dataset.rendered) {
        renderList();
        grid.dataset.rendered = '1';
      }
    });

    // 首次渲染列表（折叠状态也要有内容，避免展开空白）
    renderList();
    grid.dataset.rendered = '1';
    grid.classList.add('is-collapsed');

    return el('div.font-picker', {}, [currentBtn, grid]);
  }

  /* ======================== 暴露 ======================== */

  /** 动态注册用户导入的字体（放到顶层，避免 mount 内重复声明造成混淆） */
  async function loadFontFace(f) {
    if (!f || !f.url) return;
    try {
      if (document.fonts.check(`16px "${f.probe}"`)) return;
      const face = new FontFace(f.probe, `url("${f.url}")`);
      await face.load();
      document.fonts.add(face);
    } catch (err) {
      console.warn('[font] 加载失败', f.label, err);
    }
  }

  reader.mountReaderSettings = mount;
  reader.__applyBrightness = applyBrightness;
  reader.openReaderSettings = () => {
    mount();
    reader.toggleDrawer('settings', true);
  };
}