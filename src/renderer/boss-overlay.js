'use strict';

/**
 * 透明迷你框浮窗（渲染层）。
 *
 * 与主阅读器的分工：
 *   · 主阅读器负责解析书籍、持久化进度
 *   · 本浮窗只负责"把当前位置的正文画出来 + 响应滚动/翻页"
 *   · 位置变化通过 overlay:position 回报，主阅读器据此更新并保存
 *
 * 因此这里不引入任何解析逻辑，只处理纯文本排版与交互。
 */

const api = window.firmament;
const $ = (id) => document.getElementById(id);

const textEl = $('text');
const lineEl = $('line');
const sizeEl = $('size');
const boxEl = $('box');

/** 当前状态 */
const st = {
  bookId: null,
  chapterIndex: 0,
  ratio: 0,
  paras: [],
  total: 1,
  charsPerLine: 40,
  lineH: 24,
  offsetPara: 0,
  offsetInPara: 0,
};

/* ============================ 排版换算 ============================ */

function readLineH() {
  const cs = getComputedStyle(textEl);
  const lh = parseFloat(cs.lineHeight);
  const fs = parseFloat(cs.fontSize) || 16;
  return Number.isFinite(lh) ? lh : fs * 1.72;
}

/** 一行能放多少字（CJK 等宽，直接按宽度除字号） */
function measureCharsPerLine() {
  const cs = getComputedStyle(textEl);
  const fontPx = parseFloat(cs.fontSize) || 16;
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const usable = textEl.clientWidth - padL - padR;
  return Math.max(4, Math.floor(usable / fontPx));
}

/** 视口能装多少行 */
function measureLines() {
  const cs = getComputedStyle(textEl);
  const padT = parseFloat(cs.paddingTop) || 0;
  const padB = parseFloat(cs.paddingBottom) || 0;
  const usable = textEl.clientHeight - padT - padB;
  const lh = readLineH();
  return Math.max(2, Math.floor(usable / lh));
}

function capacity() {
  return measureCharsPerLine() * measureLines();
}

/**
 * 字色三档判定。
 *
 *   ink = 'auto'  → 跟随主界面主题：夜间系（night/mint）白字，日间系黑字
 *   ink = 'dark'  → 强制黑字（桌面是浅色壁纸时用）
 *   ink = 'light' → 强制白字（桌面是深色壁纸时用）
 *
 * ⚠ 旧实现只认 snap.dark === 'light'，而 main 进程塞进来的 dark 字段
 *   其实是 overlayInk 字符串，主题切换时它不变 —— 字色永远不跟随主题。
 *   现在 main 进程改送 themeDark（主界面真实主题）+ ink（用户档位）。
 */
function applyInk(snap) {
  const ink = snap && snap.ink ? snap.ink : 'auto';
  let light;
  if (ink === 'dark') light = false;
  else if (ink === 'light') light = true;
  else light = !!(snap && snap.themeDark);
  document.body.classList.toggle('ink-light', light);
}

/* ============================ 内容渲染 ============================ */

function extractParagraphs(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|blockquote|li|figure|figcaption)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * 依据比例定位到「段 + 段内字符偏移」，再从那里渲染满一屏。
 *
 * ⚠ 与主迷你框同一套算法：按**字符**而非段落定位。
 *   小说一段常见 200+ 字，若只按段落起点切，滚动一次（几行）
 *   段落起点不变、渲染结果完全相同，用户会以为"滚轮坏了"。
 */
function render() {
  if (!st.paras.length) {
    textEl.innerHTML = '<p>还没有打开任何书籍。</p><p>先在书架中打开一本，再进入透明迷你框。</p>';
    return;
  }

  const charsPerLine = measureCharsPerLine();
  st.charsPerLine = charsPerLine;
  st.lineH = readLineH();

  const totalChars = st.paras.reduce((a, p) => a + p.length, 0) || 1;
  const target = Math.floor(totalChars * Math.max(0, Math.min(1, st.ratio)));

  let acc = 0;
  let startPara = 0;
  let offsetInPara = 0;
  for (let i = 0; i < st.paras.length; i++) {
    if (acc + st.paras[i].length > target) {
      startPara = i;
      offsetInPara = target - acc;
      break;
    }
    acc += st.paras[i].length;
    startPara = i;
    offsetInPara = 0;
  }
  if (st.ratio >= 0.995) { startPara = Math.max(0, st.paras.length - 1); offsetInPara = 0; }

  // 段内偏移对齐到整行：滚动两行就是视觉上的两行，不会出现半行抖动
  if (offsetInPara > 0) {
    offsetInPara = Math.floor(offsetInPara / charsPerLine) * charsPerLine;
  }
  st.offsetPara = startPara;
  st.offsetInPara = offsetInPara;

  const cap = charsPerLine * measureLines();
  const picked = [];
  let used = 0;
  for (let i = startPara; i < st.paras.length; i++) {
    if (used > 0 && used + st.paras[i].length > cap * 1.5) break;
    picked.push(st.paras[i]);
    used += st.paras[i].length;
    if (used >= cap) break;
  }
  if (!picked.length) picked.push(st.paras[startPara]);

  // ⚠ 用负上边距平移整段，而不是 slice 掉已读部分：
  //   slice 会让段落重新换行（看起来像"重排"而不是"滚动"），
  //   且首行缩进会错位。
  const shiftLines = offsetInPara > 0 ? offsetInPara / charsPerLine : 0;
  const shiftPx = Math.round(shiftLines * st.lineH);

  textEl.innerHTML = picked.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  textEl.style.marginTop = shiftPx > 0 ? '-' + shiftPx + 'px' : '';
}

/* ============================ 位置推进 ============================ */

/** 把新比例回报给主进程（主阅读器负责落盘） */
function report() {
  api.overlay.reportPosition({ chapterIndex: st.chapterIndex, ratio: st.ratio });
}

/** 按行滚动（滚轮）：一行 ≈ charsPerLine 个字符 */
function scrollLines(lines) {
  if (!st.paras.length) return;
  const totalChars = st.paras.reduce((a, p) => a + p.length, 0) || 1;
  const chars = Math.abs(lines) * measureCharsPerLine();
  const step = chars / totalChars;
  const next = Math.max(0, Math.min(1, st.ratio + (lines > 0 ? step : -step)));
  if (Math.abs(next - st.ratio) < 1e-6) return;
  st.ratio = next;
  render();
  report();
}

/** 整屏翻页：按容量步进 */
function stepPage(dir) {
  if (!st.paras.length) return;
  const totalChars = st.paras.reduce((a, p) => a + p.length, 0) || 1;
  const step = capacity() / totalChars;
  const next = Math.max(0, Math.min(1, st.ratio + dir * step));
  if (Math.abs(next - st.ratio) < 1e-6) return;
  st.ratio = next;
  render();
  report();
}

/** 章末/章首自动接续下一章（跨章连续阅读） */
async function tryChapterEdge(dir) {
  if (!st.bookId) return false;
  const atEnd = st.ratio >= 0.999 && dir > 0;
  const atStart = st.ratio <= 0.001 && dir < 0;

  if (atEnd) {
    if (st.chapterIndex + 1 >= st.total) return false;
    await loadChapter(st.chapterIndex + 1, 0);
    return true;
  }
  if (atStart) {
    if (st.chapterIndex - 1 < 0) return false;
    await loadChapter(st.chapterIndex - 1, 1);
    return true;
  }
  return false;
}

async function loadChapter(index, ratio) {
  const res = await api.books.chapter(st.bookId, index);
  const data = res && res.ok ? res.data : (res && res.data ? res.data : null);
  if (!data) return false;
  st.chapterIndex = index;
  st.ratio = ratio;
  st.paras = extractParagraphs(data.html);
  render();
  updateLine();
  report();
  return true;
}

/* ============================ 进度线 ============================ */

function updateLine() {
  const overall = st.total > 0 ? ((st.chapterIndex + st.ratio) / st.total) * 100 : 0;
  lineEl.style.width = Math.max(0, Math.min(100, overall)) + '%';
}

/* ============================ 主进程推送 ============================ */

api.overlay.onContent((snap) => {
  if (!snap) return;
  st.bookId = snap.bookId;
  st.chapterIndex = Number(snap.chapterIndex) || 0;
  st.ratio = Math.max(0, Math.min(1, Number(snap.ratio) || 0));
  st.total = Number(snap.total) || 1;

  // 深色墨（浅色字）开关
  applyInk(snap);

  st.paras = extractParagraphs(snap.chapterHtml);
  render();
  updateLine();
});

api.overlay.onGeometry(() => { render(); updateLine(); });

window.addEventListener('resize', () => { render(); updateLine(); });

/* ============================ 交互 ============================ */

/** 拖动移动窗口（用屏幕坐标位移，与主迷你框一致） */
{
  const drag = $('drag');
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  drag.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    lastX = e.screenX;
    lastY = e.screenY;
    document.body.style.cursor = 'move';
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - lastX;
    const dy = e.screenY - lastY;
    lastX = e.screenX;
    lastY = e.screenY;
    if (dx || dy) api.app.moveBy(dx, dy);
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.cursor = '';
  });
}

/**
 * 双角缩放。
 *
 * 左下角（bl）与右下角（br）的区别只在锚点：
 *   · br —— 左边缘不动，向右下拖变大
 *   · bl —— 右边缘不动，向左下拖变大
 * 位移换算后交给主进程改窗口尺寸；主进程会做工作区边界校验，
 * 避免窗口被拖出屏幕后够不着。
 */
function bindResize(el, anchor) {
  let resizing = false;
  let startX = 0;
  let startY = 0;
  let baseW = 0;
  let baseH = 0;

  el.addEventListener('mousedown', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const r = await api.boss.getBoxSize('overlay');
    const box = r && r.ok ? r.data : (r && r.data);
    if (!box) return;
    resizing = true;
    startX = e.screenX;
    startY = e.screenY;
    baseW = box.width;
    baseH = box.height;
    sizeEl.classList.add('on');
    sizeEl.textContent = `${baseW} × ${baseH}`;
  });

  window.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const dx = e.screenX - startX;
    const dy = e.screenY - startY;

    // 左下角：向右拖是变小，所以 dx 取反
    const wDelta = anchor === 'bl' ? -dx : dx;
    const w = Math.round(baseW + wDelta);
    const h = Math.round(baseH + dy);

    sizeEl.textContent = `${w} × ${h}`;
    api.boss.setBoxSize(w, h, 'overlay', anchor).then(() => {
      render();
      updateLine();
    });
  });

  window.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    sizeEl.classList.remove('on');
  });
}

bindResize($('gripBL'), 'bl');
bindResize($('gripBR'), 'br');

/* 滚轮：按行滚动，到边缘自动接续下一章 */
$('box').addEventListener('wheel', (e) => {
  e.preventDefault();
  const raw = Number(e.deltaY) || 0;
  if (!raw) return;
  const dir = raw > 0 ? 1 : -1;

  // 已经贴边（且回滚不动）时，尝试跨章
  const before = st.ratio;
  scrollLines(dir * 2);
  const blocked = Math.abs(st.ratio - before) < 1e-6;
  if (blocked || (dir > 0 ? st.ratio >= 0.999 : st.ratio <= 0.001)) {
    tryChapterEdge(dir);
  }
}, { passive: false });

/* 点击两侧翻页，中间不响应（避免误触） */
$('box').addEventListener('click', (e) => {
  if (e.target.closest('#close, .grip, #drag')) return;
  const rect = boxEl.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x < rect.width * 0.28) {
    stepPage(-1);
    if (st.ratio <= 0.001) tryChapterEdge(-1);
  } else if (x > rect.width * 0.72) {
    stepPage(1);
    if (st.ratio >= 0.999) tryChapterEdge(1);
  }
});

/* 右键退出 */
$('box').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.overlay.exit();
});

/* Esc / 退出按钮 */
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.overlay.exit();
});
$('close').addEventListener('click', (e) => {
  e.stopPropagation();
  api.overlay.exit();
});

/* ============================ 启动 ============================ */

(async () => {
  const res = await api.overlay.snapshot();
  const snap = res && res.ok ? res.data : (res && res.data);
  if (snap) {
    st.bookId = snap.bookId;
    st.chapterIndex = Number(snap.chapterIndex) || 0;
    st.ratio = Math.max(0, Math.min(1, Number(snap.ratio) || 0));
    st.total = Number(snap.total) || 1;
    applyInk(snap);
    st.paras = extractParagraphs(snap.chapterHtml);
  }
  render();
  updateLine();
})();
