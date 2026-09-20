/**
 * 极简 DOM 工具。全局挂在 window.FD 上，避免引入构建工具。
 */

export function $(sel, root) {
  return (root || document).querySelector(sel);
}

export function $$(sel, root) {
  return Array.from((root || document).querySelectorAll(sel));
}

/**
 * 创建元素：el('div.cls', {attrs}, [children])
 * 支持 'div.a.b#id' 形式的快速选择器
 */
export function el(tag, attrs, children) {
  let tagName = 'div';
  const classes = [];
  let id = '';

  if (typeof tag === 'string') {
    const m = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/.exec(tag);
    if (m) {
      if (m[1]) tagName = m[1];
      const rest = m[2] || '';
      const parts = rest.split(/(?=[.#])/).filter(Boolean);
      for (const p of parts) {
        if (p[0] === '.') classes.push(p.slice(1));
        else if (p[0] === '#') id = p.slice(1);
      }
    } else {
      tagName = tag;
    }
  }

  const node = document.createElement(tagName);
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');

  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children = attrs;
    attrs = null;
  }

  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class' || k === 'className') {
        node.className = (node.className ? node.className + ' ' : '') + v;
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(node.style, v);
      } else if (k === 'dataset' && typeof v === 'object') {
        Object.assign(node.dataset, v);
      } else if (k === 'html') {
        node.innerHTML = v;
      } else if (k === 'text') {
        node.textContent = v;
      } else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v === true) {
        node.setAttribute(k, '');
      } else {
        node.setAttribute(k, String(v));
      }
    }
  }

  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) {
    for (const c of children) appendChildren(node, c);
    return;
  }
  if (children instanceof Node) {
    node.appendChild(children);
    return;
  }
  node.appendChild(document.createTextNode(String(children)));
}

export function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function on(target, type, handler, opts) {
  target.addEventListener(type, handler, opts);
  return () => target.removeEventListener(type, handler, opts);
}

/** 事件委托 */
export function delegate(root, selector, type, handler) {
  return on(root, type, (e) => {
    const t = e.target.closest(selector);
    if (t && root.contains(t)) handler(e, t);
  });
}

export function esc(str) {
  return String(str === null || str === undefined ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function debounce(fn, wait) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

export function throttle(fn, wait) {
  let last = 0;
  let timer = null;
  let lastArgs = null;
  return function throttled(...args) {
    const now = Date.now();
    lastArgs = args;
    if (now - last >= wait) {
      last = now;
      fn.apply(this, args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn.apply(this, lastArgs);
      }, wait - (now - last));
    }
  };
}

/** 下一帧（用于等布局完成再测量） */
export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export function rafThrottle(fn) {
  let scheduled = false;
  let lastArgs = null;
  return function rafThrottled(...args) {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn.apply(this, lastArgs);
    });
  };
}

/** 数字千分位 */
export function fmtNum(n) {
  const num = Number(n) || 0;
  if (num >= 100000000) return (num / 100000000).toFixed(1) + ' 亿';
  if (num >= 10000) return (num / 10000).toFixed(num >= 100000 ? 0 : 1) + ' 万';
  return String(num).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 文件体积 */
export function fmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

/** 相对时间 */
export function fmtRelative(ts) {
  if (!ts) return '从未阅读';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 阅读时长格式 */
export function fmtDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} 小时 ${rm} 分` : `${h} 小时`;
}

/** 把 Selection 文本限制在给定容器内 */
export function getSelectionText(container) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
  const range = sel.getRangeAt(0);
  if (container && !container.contains(range.commonAncestorContainer)) return '';
  return sel.toString().trim();
}

export function closestWithin(node, root, selector) {
  let cur = node;
  while (cur && cur !== root) {
    if (cur.matches && cur.matches(selector)) return cur;
    cur = cur.parentNode;
  }
  return null;
}