// Спільне ядро: API, рендер, маршрутизація, сповіщення, сокет
export const state = { user: null, pc: null, socket: null, kiosk: window.kiosk || null };

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function api(path, opts = {}) {
  const o = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: {}, credentials: 'same-origin' };
  if (opts.body instanceof FormData) o.body = opts.body;
  else if (opts.body !== undefined) { o.body = JSON.stringify(opts.body); o.headers['content-type'] = 'application/json'; }
  const r = await fetch('/api' + path, o);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login' && path !== '/me') { location.hash = '#/login'; throw new Error(data.error || 'Потрібно увійти'); }
  if (!r.ok) { const e = new Error(data.error || 'Помилка ' + r.status); if (path !== '/me') toast(e.message, 'err'); throw e; }
  return data;
}
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = p => api(p, { method: 'DELETE' });

// ---------- Мінімальний Markdown (безпечний: спершу екранування) ----------
export function md(src) {
  if (!src) return '';
  const lines = esc(src).split('\n');
  let html = '', list = null, table = null;
  const inline = t => t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, a, u) => /^(https?:|\/)/.test(u) ? `<img src="${u}" alt="${a}" class="md-img">` : m)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, a, u) => /^(https?:|\/|#)/.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${a}</a>` : m)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
  const close = () => { if (list) { html += `</${list}>`; list = null; } if (table) { html += '</tbody></table>'; table = null; } };
  for (const raw of lines) {
    const l = raw.trimEnd();
    let m;
    if (/^\|.*\|$/.test(l.trim())) {
      const cells = l.trim().slice(1, -1).split('|').map(c => c.trim());
      if (cells.every(c => /^:?-+:?$/.test(c))) continue;
      if (!table) { close(); html += '<table class="md-table"><thead><tr>' + cells.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'; table = true; continue; }
      html += '<tr>' + cells.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>'; continue;
    }
    if ((m = /^(#{1,4})\s+(.*)$/.exec(l))) { close(); const n = Math.min(4, m[1].length + 1); html += `<h${n}>${inline(m[2])}</h${n}>`; continue; }
    if ((m = /^\s*[-*•]\s+(.*)$/.exec(l))) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(l))) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(m[1])}</li>`; continue; }
    close();
    if (l.trim()) html += `<p>${inline(l)}</p>`;
  }
  close();
  return html;
}

// ---------- Тости, модальні вікна ----------
export function toast(msg, kind = 'ok', ms = 3500) {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.append(box); }
  const t = document.createElement('div');
  t.className = 'toast ' + kind; t.textContent = msg;
  box.append(t);
  setTimeout(() => t.remove(), ms);
}
export function modal(html, { wide = false, onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-bg';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}"><button class="modal-x" title="Закрити">✕</button>${html}</div>`;
  const close = () => { wrap.remove(); onClose && onClose(); };
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
  $('.modal-x', wrap).onclick = close;
  document.body.append(wrap);
  return { el: $('.modal', wrap), close };
}
export function confirmBox(text) { return Promise.resolve(window.confirm(text)); }

export function fmtDate(s, withTime = false) {
  if (!s) return '';
  const d = new Date(s.includes('T') || s.length <= 10 ? s : s.replace(' ', 'T') + 'Z');
  return withTime ? d.toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ---------- Статуси уроку (спільна легенда) ----------
export const STATES = {
  mastered: { icon: '⭐', label: 'Вміє (підтверджено вчителем)', cls: 'st-mastered' },
  done_self: { icon: '✋', label: 'Виконав сам', cls: 'st-self' },
  done_group: { icon: '👥', label: 'Виконав у групі (спостерігав)', cls: 'st-group' },
  partial: { icon: '◐', label: 'Виконав частково', cls: 'st-partial' },
  struggling: { icon: '⚠️', label: 'Потрібна допомога', cls: 'st-struggling' },
  idle: { icon: '💤', label: 'Був на уроці, але не працював', cls: 'st-idle' },
  missed: { icon: '✗', label: 'Пропустив урок', cls: 'st-missed' },
  cancelled: { icon: '🚨', label: 'Урок не відбувся', cls: 'st-cancelled' },
  none: { icon: '·', label: 'Ще не починав', cls: 'st-none' },
};

// ---------- Маршрутизатор ----------
const routes = [];
export function route(pattern, handler) { routes.push({ re: new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$'), handler }); }
export let currentCleanup = null;
export function onLeave(fn) { currentCleanup = fn; }
export async function render() {
  const hash = location.hash.slice(1) || '/';
  if (currentCleanup) { try { currentCleanup(); } catch {} currentCleanup = null; }
  document.querySelectorAll('.modal-bg').forEach(m => m.remove());
  for (const r of routes) {
    const m = r.re.exec(hash);
    if (m) { try { await r.handler(...m.slice(1).map(decodeURIComponent)); } catch (e) { console.error(e); } return; }
  }
  location.hash = '#/';
}

// ---------- Сповіщення ----------
export function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.15);
  } catch {}
}
export function systemNotify(text) {
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification('Навчальна система', { body: text });
}

// Номер комп'ютера: з кіоску або збережений у браузері (налаштовує вчитель)
export function pcHostname() { return state.kiosk?.hostname || ''; }
export function pcNumber() { return state.kiosk?.computerNo || localStorage.getItem('pcNo') || ''; }
