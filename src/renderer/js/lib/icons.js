/**
 * 图标集：内联 SVG，避免外部资源依赖，也便于用 currentColor 跟随主题。
 */

const svg = (path, opts) => {
  const o = opts || {};
  const size = o.size || 24;
  const fill = o.fill || 'none';
  const stroke = o.stroke === false ? 'none' : 'currentColor';
  const sw = o.sw || 1.7;
  return `<svg viewBox="0 0 ${o.vb || 24} ${o.vb || 24}" width="${size}" height="${size}" fill="${fill}" ${stroke !== 'none' ? `stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"` : ''} aria-hidden="true">${path}</svg>`;
};

export const Icons = {
  // —— 窗口控制 ——
  minimize: (s) => svg('<path d="M5 12h14"/>', { size: s, sw: 1.6 }),
  maximize: (s) => svg('<rect x="5.5" y="5.5" width="13" height="13" rx="2"/>', { size: s, sw: 1.5 }),
  restore: (s) => svg('<rect x="4.5" y="7.5" width="11" height="11" rx="2"/><path d="M8.5 7.5V6a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 19.5 6v8a1.5 1.5 0 0 1-1.5 1.5h-1.5"/>', { size: s, sw: 1.5 }),
  close: (s) => svg('<path d="M6 6l12 12M18 6L6 18"/>', { size: s, sw: 1.6 }),

  // —— 书架 ——
  library: (s) => svg('<path d="M4 4h5v16H4zM10 4h5v16h-5z"/><path d="M16.6 4.9l4.2 1.1-4 15.3-4.2-1.1z"/>', { size: s, sw: 1.6 }),
  clock: (s) => svg('<circle cx="12" cy="12" r="8.2"/><path d="M12 7.6V12l3 1.8"/>', { size: s, sw: 1.6 }),
  heart: (s) => svg('<path d="M12 20s-7.5-4.7-7.5-9.4A4.6 4.6 0 0 1 12 7.7a4.6 4.6 0 0 1 7.5 2.9C19.5 15.3 12 20 12 20z"/>', { size: s, sw: 1.6 }),
  folder: (s) => svg('<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l1.8 2.2h7.6a2 2 0 0 1 2 2v7.3a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/>', { size: s, sw: 1.6 }),
  plus: (s) => svg('<path d="M12 5.5v13M5.5 12h13"/>', { size: s, sw: 1.8 }),
  search: (s) => svg('<circle cx="10.8" cy="10.8" r="6.3"/><path d="M15.4 15.4L20 20"/>', { size: s, sw: 1.7 }),
  settings: (s) => svg('<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', { size: s, sw: 1.5 }),

  // —— 阅读器 ——
  book: (s) => svg('<path d="M4 5.2A1.7 1.7 0 0 1 5.7 3.5H10a2.8 2.8 0 0 1 2 2.8v12a2.3 2.3 0 0 0-1.7-2.1H4z"/><path d="M20 5.2a1.7 1.7 0 0 0-1.7-1.7H14a2.8 2.8 0 0 0-2 2.8v12a2.3 2.3 0 0 1 1.7-2.1H20z"/>', { size: s, sw: 1.6 }),
  list: (s) => svg('<path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11"/><circle cx="4.7" cy="6.5" r="1.15"/><circle cx="4.7" cy="12" r="1.15"/><circle cx="4.7" cy="17.5" r="1.15"/>', { size: s, sw: 1.7 }),
  bookmark: (s) => svg('<path d="M6.5 4.5h11a1 1 0 0 1 1 1v14.1l-6.5-4-6.5 4V5.5a1 1 0 0 1 1-1z"/>', { size: s, sw: 1.6 }),
  sun: (s) => svg('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.8v2.1M12 19.1v2.1M4.6 4.6l1.5 1.5M17.9 17.9l1.5 1.5M2.8 12h2.1M19.1 12h2.1M4.6 19.4l1.5-1.5M17.9 6.1l1.5-1.5"/>', { size: s, sw: 1.6 }),
  moon: (s) => svg('<path d="M20 14.4A8.4 8.4 0 0 1 9.6 4 8.5 8.5 0 1 0 20 14.4z"/>', { size: s, sw: 1.6 }),
  eye: (s) => svg('<path d="M2.5 12S6 5.6 12 5.6 21.5 12 21.5 12 18 18.4 12 18.4 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>', { size: s, sw: 1.6 }),
  type: (s) => svg('<path d="M5 6.5V5h14v1.5M12 5v14M9 19h6"/>', { size: s, sw: 1.7 }),
  palette: (s) => svg('<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.1 0 1.8-.9 1.8-1.9 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8h1.6a4.3 4.3 0 0 0 4.3-4.3c0-3.6-3.8-6.6-8.5-6.6z"/><circle cx="7.8" cy="11.5" r="1.1"/><circle cx="11" cy="8" r="1.1"/><circle cx="15.4" cy="9.2" r="1.1"/>', { size: s, sw: 1.5 }),
  layout: (s) => svg('<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M3.5 9.5h17M9.5 9.5V20"/>', { size: s, sw: 1.6 }),
  play: (s) => svg('<path d="M7.5 5.4l11 6.6-11 6.6z"/>', { size: s, sw: 1.6 }),
  pause: (s) => svg('<path d="M9 5.5v13M15 5.5v13"/>', { size: s, sw: 2 }),
  chevronLeft: (s) => svg('<path d="M14.5 5.5L8 12l6.5 6.5"/>', { size: s, sw: 1.8 }),
  chevronRight: (s) => svg('<path d="M9.5 5.5L16 12l-6.5 6.5"/>', { size: s, sw: 1.8 }),
  chevronDown: (s) => svg('<path d="M5.5 9l6.5 6.5L18.5 9"/>', { size: s, sw: 1.8 }),
  arrowLeft: (s) => svg('<path d="M19 12H5M11 6l-6 6 6 6"/>', { size: s, sw: 1.7 }),
  arrowUp: (s) => svg('<path d="M12 19V5M6 11l6-6 6 6"/>', { size: s, sw: 1.7 }),
  scroll: (s) => svg('<path d="M12 4.5v15M8 8.5l4-4 4 4M8 15.5l4 4 4-4"/>', { size: s, sw: 1.6 }),
  pages: (s) => svg('<rect x="3.5" y="5" width="12" height="15" rx="1.8"/><path d="M7.5 2.8h11a2 2 0 0 1 2 2v13"/>', { size: s, sw: 1.6 }),
  fullscreen: (s) => svg('<path d="M4 9V4.5h5M20 9V4.5h-5M4 15v4.5h5M20 15v4.5h-5"/>', { size: s, sw: 1.7 }),
  exitFullscreen: (s) => svg('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>', { size: s, sw: 1.7 }),
  more: (s) => svg('<circle cx="5.5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18.5" cy="12" r="1.5"/>', { size: s, sw: 1.6 }),
  pencil: (s) => svg('<path d="M16.2 4.3l3.5 3.5-11 11-4.4.9.9-4.4z"/>', { size: s, sw: 1.6 }),
  trash: (s) => svg('<path d="M4.8 7h14.4M9.5 7V4.9h5V7M6.4 7l.9 12.1a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5L17.6 7"/>', { size: s, sw: 1.6 }),
  info: (s) => svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.1"/>', { size: s, sw: 1.6 }),
  check: (s) => svg('<path d="M5 12.6l4.6 4.6L19 6.4"/>', { size: s, sw: 2 }),
  x: (s) => svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>', { size: s, sw: 1.8 }),
  refresh: (s) => svg('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.2V9h-4.8"/>', { size: s, sw: 1.7 }),
  upload: (s) => svg('<path d="M12 15.5V4M8 8l4-4 4 4M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15"/>', { size: s, sw: 1.7 }),
  grid: (s) => svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>', { size: s, sw: 1.5 }),
  rows: (s) => svg('<rect x="4" y="4.5" width="16" height="4.5" rx="1.4"/><rect x="4" y="11" width="16" height="4.5" rx="1.4"/><rect x="4" y="17.5" width="16" height="2.5" rx="1.2"/>', { size: s, sw: 1.5 }),
  eyeOff: (s) => svg('<path d="M3 3l18 18"/><path d="M10.6 10.7a3 3 0 0 0 4.2 4.2"/><path d="M6.6 6.7C4.2 8.2 2.5 12 2.5 12s3.5 6.4 9.5 6.4c1.7 0 3.2-.5 4.5-1.2M17.9 15.2c1.7-1.5 3.6-3.2 3.6-3.2S18 5.6 12 5.6c-.7 0-1.4.1-2 .3"/>', { size: s, sw: 1.6 }),
  shield: (s) => svg('<path d="M12 3.5l7.5 3v5.4c0 4.3-3 8.2-7.5 9.6-4.5-1.4-7.5-5.3-7.5-9.6V6.5z"/>', { size: s, sw: 1.6 }),
  ghost: (s) => svg('<path d="M5 19.5V11a7 7 0 1 1 14 0v8.5l-2.3-1.8-2.3 1.8-2.4-1.8-2.4 1.8L7.3 17.7z"/><circle cx="9.6" cy="10.4" r="1"/><circle cx="14.4" cy="10.4" r="1"/>', { size: s, sw: 1.5 }),
  keyboard: (s) => svg('<rect x="2.8" y="6.5" width="18.4" height="11" rx="2"/><path d="M6.5 10h.1M10 10h.1M13.5 10h.1M17 10h.1M8 13.8h8"/>', { size: s, sw: 1.6 }),
  text: (s) => svg('<path d="M4.5 6.5h15M4.5 11h15M4.5 15.5h9"/>', { size: s, sw: 1.7 }),
  candle: (s) => svg('<path d="M12 3.5c1.5 2 2.4 3.3 2.4 4.6a2.4 2.4 0 1 1-4.8 0c0-1.3.9-2.6 2.4-4.6z"/><path d="M9.5 12.5h5v7.5h-5z"/>', { size: s, sw: 1.5 }),
  file: (s) => svg('<path d="M13.5 3.5H7a1.8 1.8 0 0 0-1.8 1.8v13.4A1.8 1.8 0 0 0 7 20.5h10a1.8 1.8 0 0 0 1.8-1.8V8.8z"/><path d="M13.5 3.5v5.3h5.3"/>', { size: s, sw: 1.6 }),
  sparkle: (s) => svg('<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 16.5l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z"/>', { size: s, sw: 1.4 }),
};

/** 生成图标字符串，默认尺寸按需传入 */
export function icon(name, size) {
  const fn = Icons[name];
  return fn ? fn(size) : '';
}