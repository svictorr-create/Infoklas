import { state, api, $, esc, route, render, toast, beep, systemNotify, pcNumber, fmtDate } from './core.js';
import { registerStudent, onStudentSocket } from './student.js';
import { registerTeacher, onTeacherSocket } from './teacher.js';

// ---------- Оболонка сторінки ----------
export function shell(html, active = '') {
  const u = state.user;
  const nav = u.role === 'teacher' ? [
    ['#/', '🏫 Класи'], ['#/courses', '📚 Програма'], ['#/journal', '📊 Журнал'], ['#/help', '🙋 Запитання'],
    ['#/submissions', '📨 Роботи'], ['#/homework', '🏠 ДЗ'], ['#/devices', '🔒 Комп\'ютери'], ['#/settings', '⚙️'],
  ] : [
    ['#/', '🧭 Мій шлях'], ['#/homework', '🏠 Домашнє'], ['#/grades', '📝 Оцінки'], ['#/training', '🧠 Тренування'], ['#/criteria', '📏 Критерії'],
  ];
  $('#app').innerHTML = `
    <header class="topbar">
      <div class="brand">💻 <span>Інфо<b>Клас</b></span></div>
      <nav>${nav.map(([h, t]) => `<a href="${h}" class="${active === h ? 'active' : ''}">${t}</a>`).join('')}</nav>
      <div class="me">
        ${state.pc ? `<span class="pc-badge" title="Номер комп'ютера">ПК ${esc(state.pc)}</span>` : ''}
        <button class="bell" id="bell" title="Сповіщення">🔔<span id="bell-n"></span></button>
        <span class="who">${esc(u.name)}</span>
        <button class="btn ghost sm" id="logout">Вийти</button>
      </div>
    </header>
    <main id="main">${html}</main>`;
  $('#logout').onclick = logout;
  $('#bell').onclick = showNotifications;
  refreshBell();
  return $('#main');
}

async function refreshBell() {
  try {
    const list = await api('/notifications');
    const n = list.filter(x => !x.read).length;
    const b = $('#bell-n'); if (b) b.textContent = n ? n : '';
  } catch {}
}
async function showNotifications() {
  const list = await api('/notifications');
  const { modal } = await import('./core.js');
  modal(`<h3>Сповіщення</h3>${list.length ? '<ul class="notif-list">' + list.map(n =>
    `<li class="${n.read ? '' : 'unread'}"><a href="${esc(n.link || '#')}">${esc(n.text)}</a><small>${fmtDate(n.created_at, true)}</small></li>`).join('') + '</ul>' : '<p class="muted">Поки порожньо</p>'}`);
  document.querySelectorAll('.notif-list a').forEach(a => a.addEventListener('click', () => document.querySelector('.modal-bg')?.remove()));
  await api('/notifications/read', { body: {} });
  refreshBell();
}
export { refreshBell };

async function logout() {
  await api('/logout', { body: {} });
  state.user = null; state.socket?.disconnect(); state.socket = null;
  state.kiosk?.loggedOut?.();
  location.hash = '#/login'; location.reload();
}

// ---------- Вхід ----------
function loginPage() {
  const pc = pcNumber();
  document.body.className = 'login-body';
  $('#app').innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="lf">
        <div class="login-logo">💻</div>
        <h1>Інфо<b>Клас</b></h1>
        <p class="muted">Увійди, щоб продовжити навчання</p>
        ${pc ? `<div class="pc-big">Комп'ютер №${esc(pc)}</div>` : '<div class="pc-home">🏠 Вхід з дому або з власного пристрою</div>'}
        <label>Логін<input name="login" autocomplete="username" autocapitalize="off" required autofocus></label>
        <label>Пароль<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn big primary">Увійти</button>
        <p class="hint">Забув пароль? Підійди до вчителя — він видасть новий.</p>
      </form>
    </div>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/login', { body: { login: f.get('login'), password: f.get('password'), pc: pcNumber() || null, client: state.kiosk ? 'kiosk' : 'web' } });
      document.body.className = '';
      await boot();
    } catch {}
  };
}

// ---------- Сокет ----------
function connectSocket() {
  if (state.socket) return;
  const s = window.io({ transports: ['websocket', 'polling'] });
  state.socket = s;
  s.on('notify', n => { toast(n.text, 'info', 6000); beep(); systemNotify(n.text); refreshBell(); });
  if (state.user.role === 'teacher') onTeacherSocket(s); else onStudentSocket(s);
}

async function boot() {
  try {
    const me = await api('/me');
    state.user = me.user; state.pc = me.pc;
  } catch { state.user = null; }
  if (!state.user) { loginPage(); return; }
  state.kiosk?.loggedIn?.({ name: state.user.name, role: state.user.role });
  connectSocket();
  if (state.user.role === 'teacher') {
    registerTeacher(shell);
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  } else registerStudent(shell);
  route('/login', () => { location.hash = '#/'; });
  if (location.hash === '#/login') location.hash = '#/';
  render();
}

window.addEventListener('hashchange', () => { if (state.user) render(); else if (location.hash !== '#/login') loginPage(); });
boot();
