import { el, $ } from './dom.js';
import { icon } from './icons.js';

let host = null;
let hideTimer = null;

function ensureHost() {
  if (host && document.body.contains(host)) return host;
  host = $('#toastHost');
  if (!host) {
    host = el('div#toastHost.toast-host');
    document.body.appendChild(host);
  }
  return host;
}

/**
 * @param {string} message
 * @param {object} opts { type: 'info'|'success'|'error', duration: ms }
 */
export function toast(message, opts) {
  const o = opts || {};
  const h = ensureHost();

  const iconName = o.type === 'success' ? 'check' : o.type === 'error' ? 'info' : null;
  const node = el('div.toast', {
    class: o.type ? `toast--${o.type}` : '',
    role: 'status',
  }, [
    iconName ? el('span', { html: icon(iconName, 15), style: { display: 'flex', color: o.type === 'error' ? 'var(--c-danger)' : 'var(--c-success)' } }) : null,
    el('span', { text: message }),
  ]);

  h.appendChild(node);

  const duration = o.duration != null ? o.duration : (o.type === 'error' ? 3800 : 2200);
  const remove = () => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 240);
  };
  const timer = setTimeout(remove, duration);

  node.addEventListener('click', () => {
    clearTimeout(timer);
    remove();
  });

  // 最多同时显示 4 条
  while (h.children.length > 4) h.firstChild.remove();

  return () => { clearTimeout(timer); remove(); };
}

toast.success = (m, o) => toast(m, { ...o, type: 'success' });
toast.error = (m, o) => toast(m, { ...o, type: 'error' });

/** 供主进程来的长消息做截断展示 */
toast.wrap = (m, o) => toast(String(m).slice(0, 120), o);

/**
 * 统一处理 IPC 返回：{ ok, data } / { ok:false, error }
 * 失败时自动弹 toast 并返回 null，减少调用点的样板代码
 */
export async function call(promise, opts) {
  const o = opts || {};
  try {
    const res = await promise;
    if (!res) {
      if (!o.silent) toast.error('操作未返回结果');
      return null;
    }
    if (res.ok === false) {
      if (!o.silent) toast.error(res.error || '操作失败');
      return null;
    }
    return res.data;
  } catch (err) {
    if (!o.silent) toast.error(err && err.message ? err.message : '发生未知错误');
    return null;
  }
}