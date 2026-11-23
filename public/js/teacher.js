// Кабінет вчителя
import { state, api, put, del, $, $$, esc, md, route, render, toast, modal, fmtDate, STATES, onLeave, pcNumber } from './core.js';
import { teacherRtcInit, startScreenShare, stopScreenShare, isSharing, viewerCount, renderMaterial } from './demo.js';

let shellFn = null;
const bus = new EventTarget();
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
function listen(type, fn) { bus.addEventListener(type, fn); return () => bus.removeEventListener(type, fn); }

export function registerTeacher(shell) {
  shellFn = shell;
  route('/', classesPage);
  route('/class/:id', classPage);
  route('/student/:id', studentProfile);
  route('/folder/:id', id => folderPage(id));
  route('/folder/:id/:lesson', (id, lesson) => folderPage(id, lesson));
  route('/courses', coursesPage);
  route('/course/:id', coursePage);
  route('/lesson-edit/:id', lessonEditor);
  route('/live/:id', livePage);
  route('/journal', () => journalPage());
  route('/journal/:id', journalPage);
  route('/help', helpPage);
  route('/submissions', submissionsPage);
  route('/homework', homeworkPage);
  route('/devices', devicesPage);
  route('/settings', settingsPage);
  route('/lesson/:id', id => { location.hash = '#/lesson-edit/' + id; });
}

export function onTeacherSocket(s) {
  teacherRtcInit(s);
  ['help:new', 'finish', 'progress', 'presence', 'focus', 'login', 'live:changed', 'devices:changed'].forEach(ev => s.on(ev, d => emit('live', { ev, d })));
  s.on('focus', d => { if (d.lost) emit('focusAlert', d); });
}

const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round((n || 0) / 1024)) + ' КБ';
const filesHtml = files => (files || []).length ? `<div class="files">${files.map(f => `<a class="file" href="/api/files/${f.id}">📎 ${esc(f.name)} <small>${fmtSize(f.size)}</small></a>`).join('')}</div>` : '';
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// =====================================================================
// Класи
// =====================================================================
async function classesPage() {
  const [classes, courses, help, subs] = await Promise.all([api('/classes'), api('/courses'), api('/help'), api('/submissions?unseen=1')]);
  const main = shellFn(`
    <div class="page-head"><h1>🏫 Мої класи</h1><button class="btn primary" id="addc">+ Клас</button></div>
    <div class="stats-row">
      <a class="stat" href="#/help"><b>${help.length}</b><span>🙋 запитань без відповіді</span></a>
      <a class="stat" href="#/submissions"><b>${subs.length}</b><span>📨 нових робіт</span></a>
    </div>
    <div class="cards">${classes.map(c => `
      <div class="card class-card">
        <div class="cc-head"><h2>${esc(c.name)}</h2>${c.active_session ? '<span class="live-dot">● ІДЕ УРОК</span>' : ''}</div>
        <p class="muted">${esc(c.course_title || 'Курс не призначено')} · ${c.students} учн.</p>
        <div class="row wrap">
          ${c.active_session ? `<a class="btn primary" href="#/live/${c.active_session}">▶ До уроку</a>` : `<button class="btn primary" data-start="${c.id}">▶ Почати урок</button>`}
          <a class="btn" href="#/class/${c.id}">👥 Учні</a>
          <a class="btn" href="#/journal/${c.id}">📊 Журнал</a>
          <button class="btn ghost" data-edit="${c.id}">✏️</button>
        </div>
      </div>`).join('')}</div>`, '#/');
  $('#addc').onclick = () => classForm(null, courses);
  $$('[data-edit]', main).forEach(b => b.onclick = () => classForm(classes.find(c => c.id === +b.dataset.edit), courses));
  $$('[data-start]', main).forEach(b => b.onclick = () => startLessonDialog(+b.dataset.start));
}

function classForm(c, courses) {
  const m = modal(`<h3>${c ? 'Редагувати клас' : 'Новий клас'}</h3>
    <label>Назва<input id="cn" value="${esc(c?.name || '')}" placeholder="напр. 7-Б"></label>
    <label>Курс (програма)<select id="cc"><option value="">—</option>${courses.map(x => `<option value="${x.id}" ${c?.course_id === x.id ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select></label>
    <div class="row"><button class="btn primary" id="sv">Зберегти</button>${c ? '<button class="btn danger" id="dl">Видалити клас</button>' : ''}</div>`);
  $('#sv', m.el).onclick = async () => {
    const body = { name: $('#cn', m.el).value.trim(), course_id: +$('#cc', m.el).value || null };
    if (!body.name) return toast('Вкажіть назву', 'err');
    if (c) await put('/classes/' + c.id, body); else await api('/classes', { body });
    m.close(); render();
  };
  if (c) $('#dl', m.el).onclick = async () => { if (confirm(`Видалити клас ${c.name} разом з учнями та їхнім прогресом?`)) { await del('/classes/' + c.id); m.close(); render(); } };
}

async function startLessonDialog(classId) {
  const classes = await api('/classes');
  const cls = classes.find(c => c.id === classId);
  if (!cls.course_id) return toast('Спершу призначте класу курс', 'err');
  const [course, sessions] = await Promise.all([api('/courses/' + cls.course_id), api('/sessions?class_id=' + classId)]);
  const lastPcs = (await api('/settings')).computers;
  const held = new Set(sessions.filter(s => s.status === 'done').map(s => s.lesson_id));
  const firstNew = course.units.flatMap(u => u.lessons).find(l => !held.has(l.id));
  const m = modal(`<h3>▶ Почати урок — ${esc(cls.name)}</h3>
    <label>Урок<select id="ls">${course.units.map(u => `<optgroup label="${esc(u.title)}">${u.lessons.map(l => `<option value="${l.id}" ${firstNew?.id === l.id ? 'selected' : ''}>${held.has(l.id) ? '✓ ' : ''}${esc(l.title)}</option>`).join('')}</optgroup>`).join('')}</select></label>
    <p class="hint">✓ — уже проводився з цим класом.</p>
    <label>💻 Скільки комп'ютерів для учнів працює сьогодні?
      <input type="number" id="pcs" min="1" max="60" required placeholder="напр. 10" style="font-size:1.3em;font-weight:700;max-width:160px"></label>
    <p class="hint">Минулого разу: <b>${lastPcs}</b>. Від цього залежить розсадка.</p>
    <div class="row"><button class="btn primary big" id="go">▶ Почати</button><button class="btn ghost" id="miss">🚨 Записати урок, що не відбувся</button></div>`);
  $('#pcs', m.el).focus();
  $('#go', m.el).onclick = async () => {
    const pcs = parseInt($('#pcs', m.el).value, 10);
    if (!(pcs >= 1 && pcs <= 60)) { toast("Вкажіть кількість комп'ютерів", 'err'); $('#pcs', m.el).focus(); return; }
    const r = await api('/sessions', { body: { class_id: classId, lesson_id: +$('#ls', m.el).value, computers: pcs } });
    m.close(); location.hash = '#/live/' + r.id;
  };
  $('#miss', m.el).onclick = async () => {
    const reason = prompt('Причина (напр. «Повітряна тривога»)', 'Повітряна тривога'); if (reason === null) return;
    const date = prompt('Дата (РРРР-ММ-ДД)', new Date().toISOString().slice(0, 10)); if (!date) return;
    await api('/sessions/missed', { body: { class_id: classId, lesson_id: +$('#ls', m.el).value, date, reason } });
    toast('Записано. Учні побачать урок у списку «Треба наздогнати».'); m.close();
  };
}

// =====================================================================
// Учні класу: паролі, вхід, історія уроків
// =====================================================================
async function classPage(id) {
  const [classes, students, sessions] = await Promise.all([api('/classes'), api(`/classes/${id}/students`), api('/sessions?class_id=' + id)]);
  const cls = classes.find(c => c.id === +id);
  const main = shellFn(`
    <div class="crumbs"><a href="#/">Класи</a> › ${esc(cls.name)}</div>
    <div class="page-head"><h1>👥 ${esc(cls.name)}: учні</h1>
      <div class="row"><button class="btn" id="print">🖨 Картки з паролями</button><button class="btn primary" id="add">+ Додати учнів</button></div></div>
    <table class="tbl"><thead><tr><th>Учень</th><th>Логін</th><th>Пароль</th><th>Останній вхід</th><th></th></tr></thead><tbody>
    ${students.map(s => `<tr class="${s.active ? '' : 'dim'}">
      <td>${s.online ? '<span class="dot on" title="онлайн"></span>' : '<span class="dot"></span>'} <a href="#/student/${s.id}">${esc(s.name)}</a></td>
      <td><code>${esc(s.login)}</code></td><td><code class="pw">${esc(s.pw_plain || '••••')}</code></td>
      <td>${s.last_login ? fmtDate(s.last_login, true) : '<span class="muted">ніколи</span>'}</td>
      <td class="row-actions"><button class="btn sm" data-reset="${s.id}" title="Згенерувати новий пароль">🔑 Новий пароль</button>
        <button class="btn sm ghost" data-ed="${s.id}">✏️</button></td></tr>`).join('')}
    </tbody></table>
    <h2 class="section-title">📅 Проведені уроки</h2>
    <table class="tbl"><thead><tr><th>Дата</th><th>Урок</th><th>Статус</th><th>Присутні</th><th></th></tr></thead><tbody>
    ${sessions.map(s => `<tr><td>${fmtDate(s.date)}</td><td>${esc(s.lesson_title || '')}</td>
      <td>${s.status === 'active' ? '<span class="live-dot">● іде</span>' : s.status === 'cancelled' ? `🚨 ${esc(s.cancel_reason || 'не відбувся')}` : '✓ проведено'}</td>
      <td>${s.present}</td><td><a href="#/live/${s.id}">відкрити</a> <button class="btn sm ghost" data-delsess="${s.id}">🗑</button></td></tr>`).join('') || '<tr><td colspan=5 class="muted">Ще не було</td></tr>'}
    </tbody></table>
    <div id="print-area" class="print-only">${students.map(s => `<div class="pcard"><b>${esc(s.name)}</b><div>${esc(location.host)}</div><div>Логін: <code>${esc(s.login)}</code></div><div>Пароль: <code>${esc(s.pw_plain || '')}</code></div></div>`).join('')}</div>
  `, '#/');
  $('#print').onclick = () => window.print();
  $('#add').onclick = () => {
    const m = modal(`<h3>Додати учнів у ${esc(cls.name)}</h3><p class="muted">Кожен учень з нового рядка: «Прізвище Ім'я». Логін і пароль згенеруються автоматично.</p>
      <textarea id="names" rows="10" placeholder="Петренко Олена\nСидоренко Іван"></textarea><button class="btn primary" id="ok">Створити</button>`);
    $('#ok', m.el).onclick = async () => {
      const r = await api(`/classes/${id}/students`, { body: { names: $('#names', m.el).value } });
      m.close();
      modal(`<h3>Створено ${r.length} облікових записів</h3><table class="tbl">${r.map(x => `<tr><td>${esc(x.name)}</td><td><code>${esc(x.login)}</code></td><td><code>${esc(x.password)}</code></td></tr>`).join('')}</table>
        <p class="hint">Роздрукуйте картки кнопкою «🖨 Картки з паролями».</p>`, { onClose: render });
    };
  };
  $$('[data-reset]', main).forEach(b => b.onclick = async () => {
    if (!confirm('Згенерувати новий пароль? Старий перестане діяти.')) return;
    const r = await api(`/students/${b.dataset.reset}/reset`, { body: {} });
    modal(`<h3>Новий пароль</h3><div class="pw-big">${esc(r.password)}</div>`, { onClose: render });
  });
  $$('[data-ed]', main).forEach(b => b.onclick = () => {
    const s = students.find(x => x.id === +b.dataset.ed);
    const m = modal(`<h3>Учень</h3><label>Ім'я<input id="n" value="${esc(s.name)}"></label><label>Логін<input id="l" value="${esc(s.login)}"></label>
      <label>Клас<select id="c">${classes.map(c => `<option value="${c.id}" ${c.id === +id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="switch"><input type="checkbox" id="a" ${s.active ? 'checked' : ''}> активний</label>
      <div class="row"><button class="btn primary" id="sv">Зберегти</button><button class="btn danger" id="dl">Видалити</button></div>`);
    $('#sv', m.el).onclick = async () => { await put('/students/' + s.id, { name: $('#n', m.el).value, login: $('#l', m.el).value, class_id: +$('#c', m.el).value, active: $('#a', m.el).checked ? 1 : 0 }); m.close(); render(); };
    $('#dl', m.el).onclick = async () => { if (confirm('Видалити учня і весь його прогрес?')) { await del('/students/' + s.id); m.close(); render(); } };
  });
  $$('[data-delsess]', main).forEach(b => b.onclick = async () => { if (confirm('Видалити запис про урок (відвідування, розсадку)? Прогрес учнів залишиться.')) { await del('/sessions/' + b.dataset.delsess); render(); } });
}

async function studentProfile(id) {
  const d = await api(`/students/${id}/profile`);
  const counts = {};
  d.lessons.forEach(l => { counts[l.status?.state || 'none'] = (counts[l.status?.state || 'none'] || 0) + 1; });
  const main = shellFn(`
    <div class="crumbs"><a href="#/class/${d.cls?.id}">${esc(d.cls?.name || '')}</a> › ${esc(d.student.name)}</div>
    <h1>${esc(d.student.name)}</h1>
    <p>Логін <code>${esc(d.student.login)}</code> · пароль <code>${esc(d.student.pw_plain || '')}</code> · <a class="btn sm" href="#/folder/${d.student.id}">📂 Папка учня</a></p>
    <div class="legend">${Object.entries(counts).map(([k, n]) => `<span><span class="st ${STATES[k].cls}">${STATES[k].icon}</span> ${STATES[k].label}: <b>${n}</b></span>`).join('')}</div>
    <div class="grid2">
      <section class="card"><h3>Уроки</h3><table class="tbl compact">${d.lessons.map(l => `<tr><td><span class="st ${STATES[l.status?.state || 'none'].cls}">${STATES[l.status?.state || 'none'].icon}</span></td>
        <td><a href="#" data-cell="${l.id}">${esc(l.title)}</a></td><td class="muted">${l.status?.total ? `сам ${l.status.self}, у групі ${l.status.group} / ${l.status.total}` : ''}${l.status?.home ? ' · 🏠' : ''}</td></tr>`).join('')}</table></section>
      <section class="card"><h3>Оцінки</h3>${d.grades.map(g => `<div class="grade-row"><span class="grade">${esc(g.value)}</span> ${esc(g.kind)} ${g.lesson_title ? '— ' + esc(g.lesson_title) : ''} <small class="muted">${fmtDate(g.created_at)} ${esc(g.comment)}</small></div>`).join('') || '<p class="muted">немає</p>'}</section>
      <section class="card"><h3>Відвідування</h3><table class="tbl compact">${d.attendance.map(a => `<tr><td>${fmtDate(a.date)}</td><td>${esc(a.title || '')}</td><td>${{ present: '✅ був', late: '⏰ запізнився', absent: '❌ відсутній' }[a.status]}</td></tr>`).join('') || '<tr><td class="muted">немає записів</td></tr>'}</table></section>
      <section class="card"><h3>Де сидів і з ким</h3><table class="tbl compact">${d.seats.map(s => `<tr><td>${fmtDate(s.date)}</td><td>ПК ${s.computer_no}</td><td>${s.was_driver ? '⌨️ за клавіатурою' : '🧭 штурман'}</td><td class="muted">${esc(s.mates || 'сам')}</td></tr>`).join('') || '<tr><td class="muted">немає</td></tr>'}</table></section>
      <section class="card"><h3>Входи в систему</h3><table class="tbl compact">${d.logins.map(l => `<tr><td>${fmtDate(l.at, true)}</td><td>${l.place === 'home' ? '🏠 вдома' : '🏫 ПК ' + l.computer_no + (l.host ? ' · ' + esc(l.host) : '')}</td><td class="muted">${esc(l.client)} ${esc(l.ip || '')}</td></tr>`).join('')}</table></section>
    </div>`, '#/');
  $$('[data-cell]', main).forEach(a => a.onclick = e => { e.preventDefault(); const l = d.lessons.find(x => x.id === +a.dataset.cell); cellDialog({ id: d.student.id, name: d.student.name }, l, l.status, d.grades.filter(g => g.lesson_id === l.id), render, d.cls?.id); });
}

// =====================================================================
// Папка учня: документи з його комп'ютера (кіоск синхронізує щохвилини)
// =====================================================================
const PREVIEW = /\.(docx|pdf|png|jpe?g|gif|webp|bmp|svg|txt|csv|md|py|js|html?|css|json|xml|pas|cpp|c|h|java|cs|php|sql)$/i;
const fileIcon = n => /\.docx?$/i.test(n) ? '📝' : /\.(xlsx?|csv|ods)$/i.test(n) ? '📊' : /\.(pptx?|odp)$/i.test(n) ? '📽' : /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(n) ? '🖼' : /\.pdf$/i.test(n) ? '📕' : /\.(sb3|py|js|html?|pas|cpp|java)$/i.test(n) ? '💻' : '📄';
async function folderPage(id, lessonId) {
  const d = await api(`/students/${id}/folder`);
  let lessons = d.lessons;
  if (lessonId) lessons = [...lessons.filter(l => l.lesson_id === +lessonId), ...lessons.filter(l => l.lesson_id !== +lessonId)];
  const main = shellFn(`
    <div class="crumbs"><a href="#/journal/${d.cls?.id}">Журнал ${esc(d.cls?.name || '')}</a> › <a href="#/student/${d.student.id}">${esc(d.student.name)}</a></div>
    <div class="page-head"><h1>📂 Папка учня: ${esc(d.student.name)}</h1>
      ${lessons.length ? `<a class="btn" href="/api/students/${d.student.id}/folder.zip">⬇ Уся папка (ZIP)</a>` : ''}</div>
    <p class="folder-path">📁 Документи › InfoKlas › ${esc(d.student.name)}</p>
    <p class="hint">Копія папки з комп'ютера учня: кіоск надсилає нові та змінені файли щохвилини під час уроку і коли учень натискає «Я закінчив».
      ${d.last_sync ? `Останнє оновлення: <b>${fmtDate(d.last_sync, true)}</b>.` : ''} Учні вдома надсилають файли через сайт.</p>
    ${lessons.length ? lessons.map(L => `
      <section class="card folder-lesson ${L.lesson_id === +lessonId ? 'hl' : ''}">
        <div class="page-head"><h3>📁 ${esc(L.title)}</h3><a class="btn sm ghost" href="/api/students/${d.student.id}/folder.zip?lesson_id=${L.lesson_id}">⬇ ZIP</a></div>
        <table class="tbl compact"><tbody>${L.files.map(f => `<tr class="${f.old ? 'dim-row' : ''}">
          <td>${fileIcon(f.name)} <b>${esc(f.name)}</b>${f.old ? ' <small class="muted">(попередня версія)</small>' : ''}${f.author !== d.student.name ? ` <small class="muted">· від ${esc(f.author)} (група)</small>` : ''}</td>
          <td class="muted">${fmtSize(f.size)}</td><td class="muted">${fmtDate(f.created_at, true)}</td>
          <td>${f.submission_id ? '<span class="ok-text">✅ здано</span>' : '<span class="muted">✏️ чернетка</span>'}</td>
          <td class="row-actions">${PREVIEW.test(f.name) ? `<button class="btn sm" data-prev="${f.id}" data-name="${esc(f.name)}">👁 Переглянути</button>` : ''}
            <a class="btn sm ghost" href="/api/files/${f.id}">⬇</a></td></tr>`).join('')}</tbody></table>
      </section>`).join('') : '<div class="card"><p class="muted">Поки що порожньо. Файли з\'являться, коли учень збереже роботу в папку InfoKlas на комп\'ютері в класі (або надішле її з дому).</p></div>'}`, '#/journal');
  $$('[data-prev]', main).forEach(b => b.onclick = () => {
    modal(`<h3>${fileIcon(b.dataset.name)} ${esc(b.dataset.name)}</h3>
      <iframe class="preview-frame" src="/api/files/${b.dataset.prev}/preview" sandbox="allow-same-origin"></iframe>
      <p><a class="btn" href="/api/files/${b.dataset.prev}">⬇ Завантажити й відкрити в програмі</a></p>`, { wide: true });
  });
  if (lessonId) main.querySelector('.folder-lesson.hl')?.scrollIntoView({ block: 'start' });
}

// =====================================================================
// Програма: курси, розділи, уроки
// =====================================================================
async function coursesPage() {
  const courses = await api('/courses');
  const main = shellFn(`<div class="page-head"><h1>📚 Навчальні програми</h1><button class="btn primary" id="add">+ Курс</button></div>
    <div class="cards">${courses.map(c => `<a class="card class-card" href="#/course/${c.id}"><h2>${esc(c.title)}</h2></a>`).join('')}</div>`, '#/courses');
  $('#add', main).onclick = async () => { const t = prompt('Назва курсу (напр. «Інформатика. 7 клас»)'); if (t) { const r = await api('/courses', { body: { title: t } }); location.hash = '#/course/' + r.id; } };
}

async function coursePage(id) {
  const c = await api('/courses/' + id);
  const main = shellFn(`
    <div class="crumbs"><a href="#/courses">Програми</a> › ${esc(c.title)}</div>
    <section class="card">
      <label>Назва курсу<input id="ct" value="${esc(c.title)}"></label>
      <label>Опис (для учнів)<textarea id="cd" rows="2">${esc(c.description)}</textarea></label>
      <label>Критерії оцінювання (Markdown, бачать учні)<textarea id="ccr" rows="8">${esc(c.criteria)}</textarea></label>
      <div class="row"><button class="btn primary" id="svc">Зберегти</button><button class="btn danger ghost" id="dlc">Видалити курс</button></div>
    </section>
    <div class="page-head"><h2>Розділи та уроки</h2><button class="btn primary" id="addu">+ Розділ (тема)</button></div>
    ${c.units.map((u, i) => `<section class="card unit-edit" data-u="${u.id}">
      <div class="row"><span class="unit-n">${i + 1}</span><input class="ut" value="${esc(u.title)}" placeholder="Назва теми">
        <button class="btn sm ghost" data-up="${u.id}" title="Вище">↑</button><button class="btn sm ghost" data-delu="${u.id}">🗑</button></div>
      <label>Що вчимо (мета теми)<textarea class="ug" rows="2">${esc(u.goal)}</textarea></label>
      <label>Навіщо це учням (зв'язок з життям)<textarea class="uw" rows="2">${esc(u.why)}</textarea></label>
      <button class="btn sm" data-svu="${u.id}">Зберегти тему</button>
      <ol class="lesson-list">${u.lessons.map(l => `<li><a href="#/lesson-edit/${l.id}">${esc(l.title)}</a> <small class="muted">${l.steps} крок.</small></li>`).join('')}</ol>
      <button class="btn sm primary" data-addl="${u.id}">+ Урок</button>
    </section>`).join('')}`, '#/courses');
  $('#svc', main).onclick = async () => { await put('/courses/' + id, { title: $('#ct').value, description: $('#cd').value, criteria: $('#ccr').value }); toast('Збережено'); };
  $('#dlc', main).onclick = async () => { if (confirm('Видалити курс з усіма уроками?')) { await del('/courses/' + id); location.hash = '#/courses'; } };
  $('#addu', main).onclick = async () => { const t = prompt('Назва теми'); if (t) { await api('/units', { body: { course_id: +id, title: t } }); render(); } };
  $$('[data-svu]', main).forEach(b => b.onclick = async () => {
    const s = b.closest('[data-u]');
    await put('/units/' + b.dataset.svu, { title: $('.ut', s).value, goal: $('.ug', s).value, why: $('.uw', s).value }); toast('Тему збережено');
  });
  $$('[data-delu]', main).forEach(b => b.onclick = async () => { if (confirm('Видалити тему з уроками?')) { await del('/units/' + b.dataset.delu); render(); } });
  $$('[data-up]', main).forEach(b => b.onclick = async () => {
    const idx = c.units.findIndex(u => u.id === +b.dataset.up); if (idx < 1) return;
    await put('/units/' + c.units[idx].id, { position: idx }); await put('/units/' + c.units[idx - 1].id, { position: idx + 1 });
    c.units.forEach(async (u, i) => { if (i !== idx && i !== idx - 1) await put('/units/' + u.id, { position: i + 1 }); });
    setTimeout(render, 200);
  });
  $$('[data-addl]', main).forEach(b => b.onclick = async () => { const r = await api('/lessons', { body: { unit_id: +b.dataset.addl, title: 'Новий урок' } }); location.hash = '#/lesson-edit/' + r.id; });
}

async function lessonEditor(id) {
  const l = await api('/lessons/' + id);
  let steps = l.steps.map(s => ({ id: s.id, text: s.text }));
  const main = shellFn(`
    <div class="crumbs"><a href="#/course/${l.course_id}">${esc(l.unit_title)}</a> › редагування уроку</div>
    <div class="page-head"><h1>✏️ Урок</h1><div class="row"><button class="btn danger ghost" id="dl">Видалити урок</button><button class="btn primary big" id="save">💾 Зберегти</button></div></div>
    <section class="card">
      <label>Назва уроку<input id="t" value="${esc(l.title)}"></label>
      <div class="grid2">
        <label>🎯 Сьогодні я навчуся… (мета для учня)<textarea id="ob" rows="2">${esc(l.objectives)}</textarea></label>
        <label>💡 Навіщо це мені (зв'язок з життям)<textarea id="wh" rows="2">${esc(l.why)}</textarea></label>
      </div>
      <label>✅ Критерії успіху — кожен з нового рядка «Я можу…» (учні оцінюють себе за ними)<textarea id="sc" rows="3">${esc(l.success_criteria)}</textarea></label>
      <label>📖 Короткий конспект / теорія (Markdown: **жирний**, \`код\`, списки, ![](посилання на зображення))<textarea id="th" rows="5">${esc(l.theory)}</textarea></label>
    </section>
    <section class="card">
      <div class="page-head"><h3>📋 Інструкційна картка (кроки практичної роботи)</h3>
        <div class="row"><label class="btn sm">📥 Імпорт з DOCX/TXT<input type="file" id="imp" accept=".docx,.txt,.md" hidden></label>
          <button class="btn sm" id="bulk">📝 Вставити текстом</button></div></div>
      <p class="hint">Пишіть короткими кроками: одна дія — один крок. Учні бачать поточний крок великим і ставлять ✓. Кнопка 🖼 вставляє зображення в крок.</p>
      <div id="steps-ed"></div>
      <button class="btn" id="adds">+ Крок</button>
    </section>
    <section class="card">
      <h3>📎 Матеріали: презентація, відео, зображення, файли</h3>
      <div class="mat-ed">${l.materials.map(m => `<div class="mat-row"><span>${{ presentation: '📽', card: '📋', video: '🎬', image: '🖼', file: '📎', link: '🔗', workfile: '📂' }[m.kind] || '📎'} <a href="${esc(m.url)}" target="_blank">${esc(m.title)}</a></span><button class="btn sm ghost" data-delm="${m.id}">🗑</button></div>`).join('') || '<p class="muted">Немає матеріалів</p>'}</div>
      <form id="upf" class="row wrap">
        <select name="kind"><option value="">Тип: авто</option><option value="presentation">📽 Презентація (PDF — для демонстрації)</option><option value="card">📋 Інструкційна картка</option><option value="video">🎬 Відео</option><option value="image">🖼 Зображення</option><option value="file">📎 Файл (лише для перегляду)</option><option value="workfile">📂 Файл для роботи — копіюється в папку учня</option></select>
        <input name="title" placeholder="Назва (необов'язково)"><input type="file" name="file" required>
        <button class="btn primary">Завантажити</button></form>
      <form id="lnk" class="row wrap"><input name="url" placeholder="Посилання (YouTube, сайт…)" required><input name="title" placeholder="Назва"><button class="btn">+ Посилання</button></form>
      <p class="hint"><b>📂 Файл для роботи</b> (приклад документа, електронна таблиця, заготовка проєкту) кіоск автоматично копіює в особисту папку учня <i>Документи › InfoKlas › Учень › Урок</i>; вдома учень може його завантажити.</p>
      <p class="hint">Презентацію PowerPoint збережіть як PDF (Файл → Зберегти як → PDF) — тоді її можна показувати на всіх комп'ютерах у режимі демонстрації.</p>
    </section>
    <section class="card">
      <h3>🧠 Питання для тренування (інтервальне повторення)</h3>
      <p class="hint">Формат: <code>? питання</code>, далі варіанти: <code>+ правильний</code>, <code>- неправильний</code>, необов'язково <code>! пояснення</code>. Порожній рядок між питаннями.</p>
      <textarea id="qs" rows="8" class="mono">${esc(l.questions_text)}</textarea>
    </section>
    <section class="card"><h3>🏠 Типове домашнє завдання</h3><textarea id="hw" rows="2">${esc(l.homework)}</textarea></section>
  `, '#/courses');

  const drawSteps = () => {
    $('#steps-ed').innerHTML = steps.map((s, i) => `<div class="step-ed" data-i="${i}"><span class="step-n">${i + 1}</span>
      <textarea rows="2">${esc(s.text)}</textarea>
      <div class="col"><button class="btn sm ghost" data-mv="-1" title="Вище">↑</button><button class="btn sm ghost" data-mv="1" title="Нижче">↓</button>
      <label class="btn sm ghost" title="Вставити зображення">🖼<input type="file" accept="image/*" hidden data-img></label><button class="btn sm ghost" data-rm title="Видалити">✕</button></div></div>`).join('');
    $$('.step-ed').forEach(row => {
      const i = +row.dataset.i;
      $('textarea', row).oninput = e => { steps[i].text = e.target.value; };
      $$('[data-mv]', row).forEach(b => b.onclick = () => { const j = i + +b.dataset.mv; if (j < 0 || j >= steps.length) return; [steps[i], steps[j]] = [steps[j], steps[i]]; drawSteps(); });
      $('[data-rm]', row).onclick = () => { if (!steps[i].text || confirm('Видалити крок? Відмітки учнів для нього зникнуть.')) { steps.splice(i, 1); drawSteps(); } };
      $('[data-img]', row).onchange = async e => {
        const fd = new FormData(); fd.append('file', e.target.files[0]);
        const r = await api('/upload-image', { body: fd });
        steps[i].text += `\n![](${r.url})`; drawSteps();
      };
    });
  };
  drawSteps();
  $('#adds').onclick = () => { steps.push({ text: '' }); drawSteps(); $$('.step-ed textarea').pop().focus(); };
  $('#bulk').onclick = () => {
    const m = modal(`<h3>Вставити кроки текстом</h3><p class="muted">Кожен рядок (або пункт «1.», «2.») стане окремим кроком. Буде додано в кінець.</p><textarea id="bt" rows="12"></textarea><button class="btn primary" id="ok">Додати</button>`);
    $('#ok', m.el).onclick = () => {
      $('#bt', m.el).value.split('\n').map(s => s.trim().replace(/^(\d+[.)]|[-•*])\s*/, '')).filter(Boolean).forEach(t => steps.push({ text: t }));
      m.close(); drawSteps();
    };
  };
  $('#imp').onchange = async e => {
    const fd = new FormData(); fd.append('file', e.target.files[0]);
    const r = await api(`/lessons/${id}/import`, { body: fd });
    if (!r.steps.length) return toast('Не знайдено кроків у файлі', 'err');
    if (steps.length && !confirm(`Знайдено ${r.steps.length} кроків. Додати їх у кінець (OK) чи скасувати?`)) return;
    r.steps.forEach(t => steps.push({ text: t })); drawSteps();
    toast(`Імпортовано ${r.steps.length} кроків. Не забудьте зберегти!`);
  };
  const collect = () => ({ title: $('#t').value, objectives: $('#ob').value, why: $('#wh').value, success_criteria: $('#sc').value, theory: $('#th').value, homework: $('#hw').value, steps, questions_text: $('#qs').value });
  $('#save').onclick = async () => { await put('/lessons/' + id, collect()); toast('Урок збережено ✓'); const fresh = await api('/lessons/' + id); steps = fresh.steps.map(s => ({ id: s.id, text: s.text })); drawSteps(); };
  $('#dl').onclick = async () => { if (confirm('Видалити урок?')) { await del('/lessons/' + id); location.hash = '#/course/' + l.course_id; } };
  $('#upf').onsubmit = async e => { e.preventDefault(); await put('/lessons/' + id, collect()); await api(`/lessons/${id}/materials`, { body: new FormData(e.target) }); toast('Завантажено'); render(); };
  $('#lnk').onsubmit = async e => { e.preventDefault(); const f = new FormData(e.target); await put('/lessons/' + id, collect()); await api(`/lessons/${id}/materials`, { body: { url: f.get('url'), title: f.get('title'), kind: 'link' } }); render(); };
  $$('[data-delm]').forEach(b => b.onclick = async () => { if (confirm('Видалити матеріал?')) { await del('/materials/' + b.dataset.delm); render(); } });
}

// =====================================================================
// УРОК НАЖИВО: розсадка, присутність, прогрес, запитання, демонстрація
// =====================================================================
async function livePage(id) {
  let L = await api(`/sessions/${id}/live`);
  const s = L.session;
  const active = s.status === 'active';
  const main = shellFn(`
    <div class="live-head">
      <div><div class="crumbs"><a href="#/">Класи</a> › ${esc(s.class_name)} · ${fmtDate(s.date)}</div>
        <h1>${esc(L.lesson?.title || 'Урок')} ${active ? '<span class="live-dot">● НАЖИВО</span>' : s.status === 'cancelled' ? '🚨 ' + esc(s.cancel_reason || '') : '✓ завершено'}</h1></div>
      ${active ? `<div class="modes" id="modes">
        <button data-mode="work">🛠 Практична</button>
        <button data-mode="demo">📽 Презентація</button>
        <button data-mode="screen">📺 Мій екран</button>
        <button data-mode="lock">👀 Увага!</button>
      </div>` : ''}
    </div>
    ${active ? `<div class="toolbar">
      <button class="btn" id="allp">✅ Усі присутні</button>
      <button class="btn" id="pcn" title="Змінити кількість комп'ютерів">💻 ПК: <b id="pcn-v">${L.computers}</b></button>
      <button class="btn" id="seat">🔀 Розсадити автоматично</button>
      <button class="btn" id="rot">🔄 Поміняти ролі</button>
      <button class="btn" id="unl">🔓 Розблокувати ПК</button>
      <button class="btn" id="url">🔗 Відкрити посилання</button>
      <button class="btn" id="pushf">📤 Файли учням</button>
      ${L.lesson ? `<a class="btn ghost" href="/api/lessons/${L.lesson.id}/results.zip?class_id=${s.class_id}" title="Усі файли й знімки екрана, по папках учнів">⬇ Роботи (ZIP)</a>` : ''}
      <span class="hint" id="kiosk-sum"></span>
      <span class="spacer"></span>
      <button class="btn danger ghost" id="alarm">🚨 Тривога — перервати</button>
      <button class="btn primary" id="end">🏁 Завершити урок</button>
    </div>` : ''}
    <div id="demo-panel"></div>
    <div class="live">
      <div><div id="grid" class="pc-grid"></div><div id="unseated"></div></div>
      <aside class="live-side">
        <section class="card"><h3>🙋 Запитання <span id="hq-n"></span></h3><div id="helpq"></div></section>
        <section class="card" id="links-card"><h3>🔗 Відкриті посилання</h3><div id="links"></div></section>
        <section class="card"><h3>✅ Завершили</h3><div id="fins"></div></section>
        <section class="card"><h3>📋 Присутність</h3><div id="att"></div></section>
      </aside>
    </div>`, '#/');

  const total = L.lesson?.steps.length || 0;
  const progressOf = st => st.steps.length;

  function draw() {
    if (active) $$('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === L.session.mode));
    // --- Комп'ютери ---
    const byPc = {};
    for (const st of L.students) if (st.seat) (byPc[st.seat.computer_no] ||= []).push(st);
    const n = Math.max(L.computers, ...Object.keys(byPc).map(Number), 0);
    if ($('#pcn-v')) $('#pcn-v').textContent = L.computers;
    const ks = Object.values(L.kiosks || {});
    if ($('#kiosk-sum') && ks.length) $('#kiosk-sum').textContent = `Кіоск запущено: ${ks.filter(x => x.online).length} з ${ks.length} ПК`;
    let html = '';
    for (let pc = 1; pc <= n; pc++) {
      const g = (byPc[pc] || []).sort((a, b) => (b.seat.role === 'driver') - (a.seat.role === 'driver'));
      const prog = g.length ? Math.max(...g.map(progressOf)) : 0;
      const on = g.some(st => st.online?.includes(pc));
      const helpOpen = L.help.filter(h => h.status === 'open' && (h.computer_no === pc || g.some(st => st.id === h.student_id))).length;
      const fin = g.some(st => st.finished?.finished_at);
      const lost = g.some(st => st.focusLost);
      const k = L.kiosks?.[pc];
      html += `<div class="pc ${g.length ? '' : 'empty'} ${on ? 'on' : ''} ${helpOpen ? 'help' : ''} ${fin ? 'fin' : ''} ${lost ? 'lost' : ''}" data-pc="${pc}">
        <div class="pc-top"><b>ПК ${pc}${k?.name ? `<small class="host" title="Ім'я комп'ютера в Windows/Linux">${esc(k.name)}</small>` : ''}</b><span>${k ? (k.online ? `<span title="Кіоск запущено${k.locked ? ', заблоковано' : ''}">${k.locked ? '🔒' : '🖥'}</span> ` : '<span title="Кіоск не запущено" class="off">🖥</span> ') : ''}${on ? '🟢' : '⚪'}${helpOpen ? ' 🙋' : ''}${fin ? ' ✅' : ''}${lost ? ' ⚠️' : ''}</span></div>
        <div class="chips">${g.map(st => chip(st)).join('') || '<span class="muted small">вільний</span>'}</div>
        ${g.length && total ? `<div class="progress thin"><div style="width:${prog / total * 100}%"></div></div><div class="small muted">${prog}/${total}${prog < total && L.lesson.steps[prog] ? ' · ' + esc(L.lesson.steps[prog].text.replace(/[*`#!\[\]]/g, '').slice(0, 40)) : ''}</div>` : ''}
      </div>`;
    }
    $('#grid').innerHTML = html;
    const uns = L.students.filter(st => !st.seat && st.att !== 'absent');
    $('#unseated').innerHTML = `<div class="unseated" data-pc="0"><b>Не розсаджені:</b> ${uns.map(st => chip(st)).join('') || '<span class="muted">усі на місцях</span>'}</div>`;

    // --- Присутність ---
    $('#att').innerHTML = L.students.map(st => `<div class="att-row"><span>${st.online ? '<span class="dot on"></span>' : '<span class="dot"></span>'} ${esc(st.name)}</span>
      <span class="seg" data-sid="${st.id}">${[['present', '✅'], ['late', '⏰'], ['absent', '❌']].map(([v, i]) => `<button data-v="${v}" class="${st.att === v ? 'on' : ''}" title="${{ present: 'присутній', late: 'запізнився', absent: 'відсутній' }[v]}">${i}</button>`).join('')}</span></div>`).join('');

    // --- Запитання ---
    const open = L.help.filter(h => h.status === 'open');
    $('#hq-n').textContent = open.length ? `(${open.length})` : '';
    $('#helpq').innerHTML = open.map(h => `<div class="hq" data-h="${h.id}"><b>${esc(h.name)}</b>${h.computer_no ? ` · ПК ${h.computer_no}` : ''} · крок ${h.step_pos}
      <div class="small">${esc(h.step_text.slice(0, 80))}</div>${h.question ? `<div class="q">«${esc(h.question)}»</div>` : ''}${h.existing.length ? `<small class="muted">є ${h.existing.length} поясн.</small>` : ''}</div>`).join('') || '<p class="muted small">Немає</p>';

    // --- Завершили ---
    $('#fins').innerHTML = L.finishes.map(f => `<div class="fin-row" data-f="${f.id}">${f.file ? `<img src="${esc(f.file)}" class="thumb">` : ''}<div><b>${esc(f.name)}</b> <small class="muted">${fmtDate(f.created_at, true)}</small>${f.text ? `<div class="small">«${esc(f.text)}»</div>` : ''}${f.files?.length ? `<div class="small">📎 ${f.files.map(x => esc(x.name)).join(', ')}</div>` : ''}</div></div>`).join('') || '<p class="muted small">Поки ніхто</p>';
    const openLinks = (L.links || []).filter(k => !k.closed_at);
    $('#links-card').style.display = openLinks.length ? '' : 'none';
    $('#links').innerHTML = openLinks.map(k => `<div class="link-live"><span>${k.lock ? '🔒 ' : ''}<a href="${esc(k.url)}" target="_blank" rel="noopener">${esc(k.title || k.url)}</a>${k.pcs ? ` <small class="muted">ПК ${JSON.parse(k.pcs).join(', ')}</small>` : ''}</span><button class="btn sm" data-closelink="${k.id}" title="Закрити на ПК учнів">✕</button></div>`).join('')
      + (openLinks.length > 1 ? '<button class="btn sm ghost" data-closelink="">✕ Закрити всі</button>' : '');
    bind();
  }
  function chip(st) {
    const p = progressOf(st);
    const role = st.seat?.role === 'driver' ? '⌨️' : st.seat ? '🧭' : '';
    return `<span class="chip ${st.att === 'absent' ? 'absent' : ''} ${st.focusLost ? 'lost' : ''}" draggable="true" data-sid="${st.id}" title="${esc(st.name)} — ${p}/${total} кроків">
      ${role} ${esc(st.name.split(' ').slice(0, 2).reverse().join(' '))}${st.finished?.finished_at ? ' ✅' : ''}</span>`;
  }
  function bind() {
    $$('.chip').forEach(c => {
      c.ondragstart = e => e.dataTransfer.setData('sid', c.dataset.sid);
      c.onclick = () => studentChipDialog(+c.dataset.sid);
    });
    $$('[data-pc]').forEach(p => {
      p.ondragover = e => { e.preventDefault(); p.classList.add('drop'); };
      p.ondragleave = () => p.classList.remove('drop');
      p.ondrop = async e => {
        e.preventDefault(); p.classList.remove('drop');
        const sid = +e.dataTransfer.getData('sid'); const pc = +p.dataset.pc;
        const hasDriver = L.students.some(st => st.seat?.computer_no === pc && st.seat.role === 'driver' && st.id !== sid);
        await put(`/sessions/${id}/seating`, { student_id: sid, computer_no: pc || null, role: hasDriver ? 'navigator' : 'driver' });
        refresh();
      };
    });
    $$('.seg').forEach(sg => $$('button', sg).forEach(b => b.onclick = async () => {
      const st = L.students.find(x => x.id === +sg.dataset.sid);
      await put(`/sessions/${id}/attendance`, { student_id: st.id, status: st.att === b.dataset.v ? null : b.dataset.v });
      refresh();
    }));
    $$('.hq').forEach(h => h.onclick = () => answerDialog(L.help.find(x => x.id === +h.dataset.h), refresh));
    $$('[data-closelink]').forEach(b => b.onclick = async () => { await api(`/sessions/${id}/close-url`, { body: { link_id: b.dataset.closelink ? +b.dataset.closelink : null } }); toast('Закрито на ПК учнів'); refresh(); });
    $$('.fin-row').forEach(f => f.onclick = () => {
      const x = L.finishes.find(y => y.id === +f.dataset.f);
      modal(`<h3>${esc(x.name)} — завершив(ла)</h3>${filesHtml(x.files)}${x.file ? `<img src="${esc(x.file)}" class="shot-full">` : ''}${x.text ? `<p>Рефлексія: «${esc(x.text)}»</p>` : ''}`, { wide: true });
      put(`/submissions/${x.id}/seen`, {});
    });
  }
  function linkDialog() {
    const pcs = [...new Set(L.students.filter(st => st.seat).map(st => st.seat.computer_no))].sort((a, b) => a - b);
    const m = modal(`<h3>🔗 Відкрити посилання на комп'ютерах учнів</h3>
      <label>Посилання<input id="lu" placeholder="https://naurok.com.ua/test/..."></label>
      <label>Назва (необов'язково)<input id="lt" placeholder="напр. Тест: форматування тексту"></label>
      <label class="switch"><input type="checkbox" id="lk"> 🔒 <b>Режим тесту</b>: на весь екран, учень не може закрити чи перейти в інше вікно (лише в кіоску; закриваєте ви)</label>
      <p><b>Кому:</b></p>
      <label class="switch"><input type="radio" name="to" value="all" checked> усім учням класу (і тим, хто вдома)</label><br>
      <label class="switch"><input type="radio" name="to" value="pcs"> лише на ПК:</label>
      <div class="row wrap pcs-pick">${(pcs.length ? pcs : Array.from({ length: L.computers }, (_, i) => i + 1)).map(n => `<label class="switch"><input type="checkbox" value="${n}"> ${n}</label>`).join('')}</div>
      <p class="hint">У кіоску посилання відкривається в його вікні (браузери під час уроку заблоковані). У звичайному браузері — у новій вкладці.</p>
      <button class="btn primary big" id="lsend">🔗 Відкрити</button>`);
    $('#lu', m.el).focus();
    $$('.pcs-pick input', m.el).forEach(c => c.onchange = () => { m.el.querySelector('input[value=pcs]').checked = true; });
    $('#lsend', m.el).onclick = async () => {
      const toPcs = m.el.querySelector('input[name=to]:checked').value === 'pcs';
      const sel = toPcs ? $$('.pcs-pick input:checked', m.el).map(c => +c.value) : null;
      if (toPcs && !sel.length) return toast('Оберіть ПК', 'err');
      const r = await api(`/sessions/${id}/open-url`, { body: { url: $('#lu', m.el).value, title: $('#lt', m.el).value, lock: $('#lk', m.el).checked, pcs: sel } });
      m.close(); toast('Посилання відкрито: ' + r.url); refresh();
    };
  }
  function filesDialog() {
    const m = modal(`<h3>📤 Надіслати файли учням</h3>
      <p class="muted">Файли (приклади документів, таблиці, заготовки) з'являться в особистій папці кожного учня
        <i>Документи › InfoKlas › Учень › ${esc(L.lesson?.title || 'Урок')}</i> і додадуться до уроку як «Файл для роботи» — вдома учні теж зможуть їх завантажити.</p>
      <input type="file" id="pf" multiple><br><br><button class="btn primary big" id="psend">📤 Надіслати</button>`);
    $('#psend', m.el).onclick = async () => {
      const list = $('#pf', m.el).files; if (!list.length) return toast('Оберіть файли', 'err');
      const fd = new FormData(); [...list].forEach(f => fd.append('files', f));
      const r = await api(`/sessions/${id}/files`, { body: fd });
      m.close(); toast('Надіслано: ' + r.names.join(', '));
    };
  }
  function studentChipDialog(sid) {
    const st = L.students.find(x => x.id === sid);
    const done = new Map(st.steps.map(p => [p.step_id, p.via]));
    const m = modal(`<h3>${esc(st.name)}</h3>
      <p>${st.seat ? `ПК ${st.seat.computer_no} · ${st.seat.role === 'driver' ? '⌨️ за клавіатурою' : '🧭 штурман'}` : 'не розсаджений'} ${st.online ? '· 🟢 онлайн' : ''}</p>
      <div class="row wrap">${st.seat ? `<button class="btn" id="drv">⌨️ Зробити водієм</button><button class="btn ghost" id="uns">Зняти з ПК</button>` : ''}
        <a class="btn ghost" href="#/student/${st.id}">Профіль</a><a class="btn ghost" href="#/folder/${st.id}/${L.lesson?.id || ''}">📂 Папка учня</a></div>
      <h4>Кроки</h4><ol class="steps-mini">${(L.lesson?.steps || []).map(s => `<li class="${done.has(s.id) ? 'ok' : ''}">${done.get(s.id) === 'self' ? '✋' : done.get(s.id) === 'group' ? '👥' : '·'} ${esc(s.text.slice(0, 70))}</li>`).join('')}</ol>
      <h4>Вміння за цей урок</h4>
      <div class="row"><button class="btn" data-m="1">⭐ Вміє</button><button class="btn" data-m="0">⚠️ Не вміє</button><button class="btn ghost" data-m="">скинути</button></div>
      <p class="hint">Перевірка: попросіть учня показати/пояснити крок. Це найточніший спосіб дізнатися, хто вміє, а хто лише спостерігав.</p>`);
    if (st.seat) {
      $('#drv', m.el).onclick = async () => { await put(`/sessions/${id}/seating`, { student_id: sid, computer_no: st.seat.computer_no, role: 'driver' }); m.close(); refresh(); };
      $('#uns', m.el).onclick = async () => { await put(`/sessions/${id}/seating`, { student_id: sid, computer_no: null }); m.close(); refresh(); };
    }
    $$('[data-m]', m.el).forEach(b => b.onclick = async () => { await put('/mastery', { student_id: sid, lesson_id: L.lesson.id, mastery: b.dataset.m === '' ? null : +b.dataset.m }); toast('Збережено'); m.close(); });
  }
  const refresh = debounce(async () => {
    if (!$('#grid')) return;
    L = await api(`/sessions/${id}/live`); draw();
  }, 250);

  // --- Кнопки керування ---
  if (active) {
    $('#allp').onclick = async () => { await api(`/sessions/${id}/attendance/all`, { body: { status: 'present' } }); refresh(); };
    $('#seat').onclick = async () => {
      await api(`/sessions/${id}/seating/auto`, { body: {} });
      toast('Розсаджено: за клавіатуру — ті, хто найменше працював руками; групи змішані за рівнем.', 'ok', 6000); refresh();
    };
    $('#pcn').onclick = async () => {
      const n = prompt(`Скільки комп'ютерів працює зараз?`, L.computers); if (!n) return;
      const r = await put(`/sessions/${id}/computers`, { computers: +n });
      toast(r.unseated ? `Тепер ПК: ${n}. ${r.unseated} учн. без місця — натисніть «Розсадити» або перетягніть їх.` : `Тепер ПК: ${n}`, 'ok', 6000);
      refresh();
    };
    $('#rot').onclick = async () => { await api(`/sessions/${id}/seating/rotate`, { body: {} }); toast('Ролі змінено — учні побачать сповіщення'); refresh(); };
    $('#url').onclick = linkDialog;
    $('#pushf').onclick = filesDialog;
    $('#unl').onclick = async () => { await api('/devices/command', { body: { cmd: 'unlock' } }); toast('Команду розблокування надіслано всім ПК'); };
    $('#end').onclick = async () => { if (!confirm('Завершити урок? Хто не відмічений — буде записаний як відсутній.' + (L.closeKiosk ? '\nКіоски на всіх ПК закриються.' : ''))) return; stopScreenShare(); await api(`/sessions/${id}/end`, { body: {} }); render(); };
    $('#alarm').onclick = async () => {
      const reason = prompt('Причина', 'Повітряна тривога'); if (reason === null) return;
      stopScreenShare(); await api(`/sessions/${id}/cancel`, { body: { reason } });
      toast('Урок позначено як перерваний. Учні отримали сповіщення, що можуть доробити вдома.', 'ok', 6000); render();
    };
    $$('#modes button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
    if (L.session.mode === 'demo') presenter(); else if (L.session.mode === 'screen') screenPanel(true);
  }

  async function setMode(mode, demo) {
    if (mode !== 'screen' && isSharing()) stopScreenShare();
    if (mode === 'demo') return presenter(true);
    if (mode === 'screen') return screenPanel();
    $('#demo-panel').innerHTML = '';
    await api(`/sessions/${id}/mode`, { body: { mode, demo: demo || {} } });
    L.session.mode = mode; draw();
  }

  async function presenter(start) {
    const mats = (L.lesson?.materials || []).filter(m => ['presentation', 'image', 'video'].includes(m.kind) || /pdf|image|video/.test(m.mime || ''));
    if (!mats.length) { toast('Додайте до уроку презентацію (PDF), зображення або відео', 'err'); return; }
    let demo = L.session.demo?.material_id ? { ...L.session.demo } : { material_id: mats[0].id, page: 1 };
    let pages = 1;
    const panel = $('#demo-panel');
    panel.innerHTML = `<section class="card presenter">
      <div class="row wrap"><b>📽 Презентація на екранах учнів</b>
        <select id="pm">${mats.map(m => `<option value="${m.id}" ${m.id === demo.material_id ? 'selected' : ''}>${esc(m.title)}</option>`).join('')}</select>
        <button class="btn" id="pp">◀</button><span id="pn"></span><button class="btn" id="pnx">▶</button>
        <button class="btn ghost" id="pfs">⛶ На проєктор</button><span class="hint">Стрілки ← → на клавіатурі</span></div>
      <div id="pstage" class="pstage"></div></section>`;
    const send = () => state.socket.emit('demo:state', { session_id: +id, demo });
    const draw2 = async () => {
      const mat = mats.find(m => m.id === demo.material_id);
      pages = await renderMaterial($('#pstage'), mat, demo) || 1;
      $('#pn').textContent = `${demo.page} / ${pages}`;
    };
    if (start) { await api(`/sessions/${id}/mode`, { body: { mode: 'demo', demo } }); L.session.mode = 'demo'; draw(); }
    $('#pm').onchange = e => { demo = { material_id: +e.target.value, page: 1 }; send(); draw2(); };
    const go = d => { demo.page = Math.max(1, Math.min(pages, demo.page + d)); send(); draw2(); };
    $('#pp').onclick = () => go(-1); $('#pnx').onclick = () => go(1);
    $('#pfs').onclick = () => $('#pstage').requestFullscreen?.();
    const key = e => { if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return; if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') go(1); if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1); };
    document.addEventListener('keydown', key);
    stopKeys = () => document.removeEventListener('keydown', key);
    const v = () => { const vid = $('#pstage video'); if (vid) { vid.controls = true; vid.onplay = vid.onpause = vid.onseeked = () => { demo.playing = !vid.paused; demo.time = vid.currentTime; send(); }; } };
    await draw2(); v();
  }
  let stopKeys = () => {};

  async function screenPanel(resume) {
    const panel = $('#demo-panel');
    if (!isSharing()) {
      try {
        await startScreenShare(() => { toast('Трансляцію зупинено'); setMode('work'); });
      } catch { toast('Трансляцію скасовано', 'err'); if (resume) panel.innerHTML = `<section class="card"><b>📺 Режим «Мій екран» активний, але трансляція не йде.</b> <button class="btn primary" id="rs">Відновити трансляцію</button> <button class="btn" id="st">Повернути практичну</button></section>`; $('#rs')?.addEventListener('click', () => screenPanel()); $('#st')?.addEventListener('click', () => setMode('work')); return; }
    }
    await api(`/sessions/${id}/mode`, { body: { mode: 'screen', demo: {} } });
    L.session.mode = 'screen'; draw();
    panel.innerHTML = `<section class="card"><b>📺 Ваш екран транслюється на комп'ютери учнів</b> · <span id="vc">0</span> переглядачів <button class="btn" id="st">⏹ Зупинити</button></section>`;
    $('#st').onclick = () => { stopScreenShare(); setMode('work'); };
    const t = setInterval(() => { const e = $('#vc'); if (e) e.textContent = viewerCount(); else clearInterval(t); }, 1500);
  }

  draw();
  const offs = [listen('live', refresh), listen('focusAlert', e => toast(`⚠️ ${e.detail.name} залишив(ла) вікно демонстрації`, 'err'))];
  onLeave(() => { offs.forEach(f => f()); stopKeys(); });
}

// Відповідь на запит пояснення
function answerDialog(h, after) {
  const m = modal(`<h3>🙋 ${esc(h.name)}${h.computer_no ? ' · ПК ' + h.computer_no : ''}</h3>
    <div class="quote"><b>Крок ${h.step_pos}${h.lesson_title ? ' · ' + esc(h.lesson_title) : ''}:</b> ${md(h.step_text)}</div>
    ${h.question ? `<p>Запитання: «<b>${esc(h.question)}</b>»</p>` : ''}
    ${h.existing.length ? `<p class="muted">Вже є пояснення до цього кроку — можна надіслати одним кліком:</p>${h.existing.map(e => `<div class="ex"><div>${md(e.text)}</div><div class="ex-foot"><small>★ ${(+e.avg).toFixed(1)} (${e.votes})</small><button class="btn sm" data-ex="${e.id}">Надіслати це</button></div></div>`).join('')}` : ''}
    <label>Нове пояснення (його збережено до кроку — побачать й інші учні)<textarea id="ans" rows="4" placeholder="Напр.: Виділи текст, потім знайди вгорі кнопку «Ж»…"></textarea></label>
    <button class="btn primary" id="send">📤 Надіслати</button>`);
  $('#ans', m.el).focus();
  $$('[data-ex]', m.el).forEach(b => b.onclick = async () => { await api(`/help/${h.id}/answer`, { body: { explanation_id: +b.dataset.ex } }); m.close(); toast('Надіслано'); after && after(); });
  $('#send', m.el).onclick = async () => {
    const r = await api(`/help/${h.id}/answer`, { body: { text: $('#ans', m.el).value } });
    m.close(); toast(r.closed > 1 ? `Надіслано ${r.closed} учням з тим самим питанням` : 'Надіслано'); after && after();
  };
}

async function helpPage() {
  const list = await api('/help');
  const main = shellFn(`<h1>🙋 Запитання учнів</h1><p class="muted">Включно з тими, хто працює вдома. Пояснення зберігаються до кроку й допомагають усім.</p>
    ${list.map(h => `<div class="card hq" data-h="${h.id}"><b>${esc(h.name)}</b> · ${esc(h.lesson_title)} · крок ${h.step_pos} <small class="muted">${fmtDate(h.created_at, true)}</small>
      <div class="small">${esc(h.step_text.slice(0, 120))}</div>${h.question ? `<div class="q">«${esc(h.question)}»</div>` : ''}</div>`).join('') || '<p class="muted">Усі запитання мають відповіді 👍</p>'}`, '#/help');
  $$('.hq', main).forEach(x => x.onclick = () => answerDialog(list.find(h => h.id === +x.dataset.h), render));
  onLeave(listen('live', debounce(() => location.hash === '#/help' && render(), 500)));
}

// =====================================================================
// Журнал: учні × уроки
// =====================================================================
async function journalPage(classId) {
  const classes = await api('/classes');
  if (!classId) { if (classes[0]) location.hash = '#/journal/' + classes[0].id; else shellFn('<p>Створіть клас</p>', '#/journal'); return; }
  const J = await api(`/classes/${classId}/journal`);
  const units = [];
  J.lessons.forEach(l => { const u = units.at(-1); if (u?.name === l.unit) u.n++; else units.push({ name: l.unit, n: 1 }); });
  const sessByLesson = {};
  J.sessions.forEach(s => (sessByLesson[s.lesson_id] ||= []).push(s));
  const main = shellFn(`
    <div class="page-head"><h1>📊 Журнал</h1>
      <div class="row"><select id="cls">${classes.map(c => `<option value="${c.id}" ${c.id === +classId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <button class="btn" id="csv">⬇ CSV</button></div></div>
    <div class="legend">${Object.values(STATES).map(s => `<span><span class="st ${s.cls}">${s.icon}</span> ${s.label}</span>`).join('')}</div>
    <div class="journal-wrap"><table class="journal">
      <thead><tr><th rowspan="2" class="sticky">Учень</th>${units.map(u => `<th colspan="${u.n}" class="unit-th">${esc(u.name)}</th>`).join('')}<th rowspan="2" title="Скільки разів був за клавіатурою / скільки уроків розсаджений">⌨️</th><th rowspan="2">Сер.</th></tr>
      <tr>${J.lessons.map((l, i) => `<th class="lth" title="${esc(l.title)}"><div>${i + 1}. ${esc(l.title)}</div>
        <small>${(sessByLesson[l.id] || []).map(s => s.status === 'cancelled' ? `<span title="${esc(s.cancel_reason || '')}">🚨${fmtDate(s.date).slice(0, 5)}</span>` : fmtDate(s.date).slice(0, 5)).join(' ')}</small></th>`).join('')}</tr></thead>
      <tbody>${J.students.map(st => {
        const gr = Object.values(J.grades[st.id] || {}).flat().map(g => parseFloat(g.value)).filter(x => !isNaN(x));
        return `<tr><td class="sticky"><a href="#/student/${st.id}">${esc(st.name)}</a> <a class="folder-link" href="#/folder/${st.id}" title="Папка учня — документи з його комп'ютера">📂</a></td>
        ${J.lessons.map(l => { const c = J.cells[st.id][l.id]; const S = STATES[c.state]; const g = (J.grades[st.id]?.[l.id] || []);
          return `<td class="cell ${S.cls}" data-s="${st.id}" data-l="${l.id}" title="${esc(S.label)}${c.total ? ` · сам ${c.self}, у групі ${c.group} з ${c.total}` : ''}">${S.icon}${c.home ? '<sup>🏠</sup>' : ''}${c.files?.length ? '<sup title="Є файли">📎</sup>' : ''}${g.length ? `<b class="g">${g.map(x => esc(x.value)).join(',')}</b>` : ''}</td>`; }).join('')}
        <td class="muted">${st.driver}/${st.seated}</td><td><b>${gr.length ? (gr.reduce((a, b) => a + b, 0) / gr.length).toFixed(1) : ''}</b></td></tr>`; }).join('')}</tbody>
    </table></div>
    <p class="hint">Клікніть клітинку, щоб побачити деталі (кроки, скриншот, самооцінку), підтвердити вміння чи поставити оцінку.</p>`, '#/journal');
  $('#cls').onchange = e => { location.hash = '#/journal/' + e.target.value; };
  $$('.cell', main).forEach(td => td.onclick = () => {
    const st = J.students.find(s => s.id === +td.dataset.s), l = J.lessons.find(x => x.id === +td.dataset.l);
    cellDialog(st, l, J.cells[st.id][l.id], J.grades[st.id]?.[l.id] || [], render, J.cls.id);
  });
  $('#csv').onclick = () => {
    const rows = [['Учень', ...J.lessons.map(l => l.title), 'За клавіатурою']];
    J.students.forEach(st => rows.push([st.name, ...J.lessons.map(l => { const c = J.cells[st.id][l.id]; return STATES[c.state].label + ((J.grades[st.id]?.[l.id] || []).length ? ' / ' + J.grades[st.id][l.id].map(g => g.value).join(',') : ''); }), `${st.driver}/${st.seated}`]));
    const csv = '﻿' + rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `журнал-${J.cls.name}.csv`; a.click();
  };
}

function cellDialog(st, l, c, grades, after, classId) {
  c = c || { state: 'none', total: 0, self: 0, group: 0 };
  const sa = c.self_assess ? Object.entries(c.self_assess) : [];
  const m = modal(`<h3>${esc(st.name)} — ${esc(l.title)}</h3>
    <p><span class="st ${STATES[c.state].cls}">${STATES[c.state].icon}</span> ${STATES[c.state].label}</p>
    ${c.total ? `<p>Кроки: ✋ сам <b>${c.self}</b>, 👥 у групі <b>${c.group}</b> з ${c.total}${c.home ? ` · 🏠 вдома: ${c.home}` : ''}</p>` : ''}
    ${c.finished_at ? `<p>Здано: ${fmtDate(c.finished_at, true)}</p>` : ''}
    ${c.files?.length ? `<p><b>Файли роботи:</b></p>${filesHtml(c.files)}` : ''}
    <p><a class="btn sm" href="#/folder/${st.id}/${l.id}">📂 Відкрити папку учня (цей урок)</a></p>
    ${c.screenshot ? `<img src="${esc(c.screenshot)}" class="shot-prev">` : ''}
    ${classId ? `<p><a href="/api/lessons/${l.id}/results.zip?class_id=${classId}">⬇ Роботи всього класу з цього уроку (ZIP)</a></p>` : ''}
    ${sa.length ? `<p><b>Самооцінка:</b></p><ul>${sa.map(([k, v]) => `<li>${['🔴', '🟡', '🟢'][v]} ${esc(k)}</li>`).join('')}</ul>` : ''}
    ${c.reflection ? `<p><b>Рефлексія:</b> «${esc(c.reflection)}»</p>` : ''}
    <h4>Підтвердження вміння</h4>
    <div class="row"><button class="btn ${c.mastery === 1 ? 'primary' : ''}" data-m="1">⭐ Вміє</button><button class="btn ${c.mastery === 0 ? 'primary' : ''}" data-m="0">⚠️ Не вміє</button><button class="btn ghost" data-m="">скинути</button></div>
    <h4>Оцінки</h4>
    ${grades.map(g => `<div class="grade-row"><span class="grade">${esc(g.value)}</span> ${esc(g.kind)} <small class="muted">${esc(g.comment)}</small> <button class="btn sm ghost" data-dg="${g.id}">🗑</button></div>`).join('')}
    <div class="row wrap"><select id="gv">${Array.from({ length: 12 }, (_, i) => `<option>${12 - i}</option>`).join('')}<option>н/а</option></select>
      <select id="gk"><option>Практична робота</option><option>Домашня робота</option><option>Тематична</option><option>Усна відповідь</option></select>
      <input id="gc" placeholder="Коментар для учня (що добре, що покращити)"><button class="btn primary" id="ag">Поставити</button></div>`);
  $$('[data-m]', m.el).forEach(b => b.onclick = async () => { await put('/mastery', { student_id: st.id, lesson_id: l.id, mastery: b.dataset.m === '' ? null : +b.dataset.m }); m.close(); after(); });
  $$('[data-dg]', m.el).forEach(b => b.onclick = async () => { await del('/grades/' + b.dataset.dg); m.close(); after(); });
  $('#ag', m.el).onclick = async () => { await api('/grades', { body: { student_id: st.id, lesson_id: l.id, value: $('#gv', m.el).value, kind: $('#gk', m.el).value, comment: $('#gc', m.el).value } }); toast('Оцінку виставлено, учень отримав сповіщення'); m.close(); after(); };
}

// =====================================================================
// Здані роботи, ДЗ
// =====================================================================
async function submissionsPage() {
  const list = await api('/submissions');
  const main = shellFn(`<h1>📨 Здані роботи</h1>
    <div class="subs">${list.map(s => `<div class="card sub ${s.seen ? '' : 'new'}" data-id="${s.id}">
      ${s.file && /\.(png|jpe?g|webp)$/i.test(s.file) ? `<img src="${esc(s.file)}" class="thumb-big">` : s.file ? `<a href="${esc(s.file)}" target="_blank">📎 файл</a>` : ''}
      <div><b>${esc(s.group_names.length > 1 ? s.group_names.join(', ') : s.name)}</b> · ${esc(s.class_name)}<br>
      ${s.kind === 'homework' ? '🏠 ДЗ' : '✅ Практична'}: ${esc(s.lesson_title || '')} <small class="muted">${fmtDate(s.created_at, true)}</small>
      ${s.text ? `<div class="small">«${esc(s.text)}»</div>` : ''}${s.files?.length ? `<div class="small">📎 ${s.files.length} файл(и)</div>` : ''}</div></div>`).join('') || '<p class="muted">Поки порожньо</p>'}</div>`, '#/submissions');
  $$('.sub', main).forEach(el => el.onclick = async () => {
    const s = list.find(x => x.id === +el.dataset.id);
    await put(`/submissions/${s.id}/seen`, {}); el.classList.remove('new');
    const m = modal(`<h3>${esc(s.name)} — ${esc(s.lesson_title || '')}</h3>
      ${s.hw_text ? `<div class="quote">${md(s.hw_text)}</div>` : ''}
      ${s.file && /\.(png|jpe?g|webp)$/i.test(s.file) ? `<img src="${esc(s.file)}" class="shot-full">` : s.file ? `<a class="btn" href="${esc(s.file)}" target="_blank">📎 Відкрити файл</a>` : ''}
      ${filesHtml(s.files)}
      ${s.text ? `<p>«${esc(s.text)}»</p>` : ''}
      ${s.group_names.length > 1 ? `<p class="muted">Група: ${esc(s.group_names.join(', '))}</p>` : ''}
      <div class="row wrap"><select id="gv">${Array.from({ length: 12 }, (_, i) => `<option>${12 - i}</option>`).join('')}</select>
      <input id="gc" placeholder="Коментар"><button class="btn primary" id="ag">Поставити оцінку ${esc(s.name.split(' ')[0])}</button></div>`, { wide: true });
    $('#ag', m.el).onclick = async () => { await api('/grades', { body: { student_id: s.student_id, lesson_id: s.lesson_id, value: $('#gv', m.el).value, kind: s.kind === 'homework' ? 'Домашня робота' : 'Практична робота', comment: $('#gc', m.el).value } }); toast('Оцінку виставлено'); m.close(); };
  });
}

async function homeworkPage() {
  const [list, classes] = await Promise.all([api('/homework'), api('/classes')]);
  const main = shellFn(`<div class="page-head"><h1>🏠 Домашні завдання</h1><button class="btn primary" id="add">+ Задати</button></div>
    <table class="tbl"><thead><tr><th>Клас</th><th>Урок</th><th>Завдання</th><th>Термін</th><th>Здали</th><th></th></tr></thead><tbody>
    ${list.map(h => `<tr><td>${esc(h.class_name)}</td><td>${esc(h.lesson_title || '')}</td><td>${md(h.text)}</td><td>${h.due ? fmtDate(h.due) : ''}</td><td>${h.submitted}</td><td><button class="btn sm ghost" data-del="${h.id}">🗑</button></td></tr>`).join('')}</tbody></table>`, '#/homework');
  $$('[data-del]', main).forEach(b => b.onclick = async () => { if (confirm('Видалити?')) { await del('/homework/' + b.dataset.del); render(); } });
  $('#add').onclick = async () => {
    const m = modal(`<h3>Задати домашнє завдання</h3>
      <label>Клас<select id="hc">${classes.map(c => `<option value="${c.id}" data-course="${c.course_id}">${esc(c.name)}</option>`).join('')}</select></label>
      <label>Урок<select id="hl"></select></label>
      <label>Завдання<textarea id="ht" rows="4"></textarea></label>
      <label>Здати до<input type="date" id="hd"></label>
      <button class="btn primary" id="ok">Задати</button>`);
    let lessons = [];
    const loadL = async () => {
      const cid = $('#hc', m.el).selectedOptions[0]?.dataset.course;
      const c = cid && cid !== 'null' ? await api('/courses/' + cid) : { units: [] };
      lessons = c.units.flatMap(u => u.lessons);
      $('#hl', m.el).innerHTML = '<option value="">—</option>' + c.units.map(u => `<optgroup label="${esc(u.title)}">${u.lessons.map(l => `<option value="${l.id}">${esc(l.title)}</option>`).join('')}</optgroup>`).join('');
    };
    $('#hc', m.el).onchange = loadL; await loadL();
    $('#hl', m.el).onchange = async e => { if (e.target.value && !$('#ht', m.el).value) { const l = await api('/lessons/' + e.target.value); $('#ht', m.el).value = l.homework || ''; } };
    const d = new Date(); d.setDate(d.getDate() + 7); $('#hd', m.el).value = d.toISOString().slice(0, 10);
    $('#ok', m.el).onclick = async () => { await api('/homework', { body: { class_id: +$('#hc', m.el).value, lesson_id: +$('#hl', m.el).value || null, text: $('#ht', m.el).value, due: $('#hd', m.el).value } }); m.close(); render(); };
  };
}

// =====================================================================
// Комп'ютери (кіоск) та налаштування
// =====================================================================
async function devicesPage() {
  const [devs, codes, logins] = await Promise.all([api('/devices'), api('/unlock-codes'), api('/logins')]);
  const main = shellFn(`
    <div class="page-head"><h1>🔒 Комп'ютери класу (Lockdown)</h1>
      <div class="row"><button class="btn" id="lockall">🔒 Заблокувати всі</button><button class="btn" id="unlockall">🔓 Розблокувати всі</button><button class="btn" id="exitall">⏏ Закрити кіоск на всіх</button></div></div>
    <section class="card"><h3>▶ Запуск кіоску через Veyon</h3>
      <p class="muted">Veyon → виділіть комп'ютери → <b>«Запустити програму»</b> і вставте команду (збережіть її у Veyon, щоб наступного разу обрати зі списку):</p>
      <p>Windows: <code>"C:\\Program Files\\InfoKlas Kiosk\\InfoKlas Kiosk.exe" --open</code></p>
      <p>Linux Mint: <code>infoklas-kiosk --open</code></p>
      <p class="hint"><code>--open</code> — учні одразу бачать вхід. Без нього кіоск стартує заблокованим, і ви розблоковуєте ПК звідси чи з уроку. Після «Завершити урок» кіоски закриваються самі (вимикається в ⚙️).</p></section>
    <section class="card">
      <h3>Одноразовий код розблокування</h3>
      <p class="muted">Після перезавантаження ПК кіоск-клієнт блокує екран. Учень не може його обійти — розблокувати можна лише кодом від вчителя або кнопкою тут.</p>
      <div class="row"><button class="btn primary" id="gen">🔑 Код розблокування</button><button class="btn ghost" id="genx">🛠 Код сервісного виходу з кіоску</button></div>
      <div id="code"></div>
      <details><summary>Останні коди</summary><table class="tbl compact">${codes.map(c => `<tr><td><code>${c.code}</code></td><td>${c.kind === 'exit' ? 'вихід' : 'розблок.'}</td><td>${c.used_at ? '✓ ' + esc(c.used_by) + ' ' + fmtDate(c.used_at, true) : new Date(c.expires_at) < new Date() ? 'прострочений' : 'діє'}</td></tr>`).join('')}</table></details>
    </section>
    <section class="card"><h3>Зареєстровані ПК</h3>
      <table class="tbl"><thead><tr><th>ПК</th><th>Ім'я комп'ютера</th><th>Стан</th><th>Зв'язок</th><th></th></tr></thead><tbody>
      ${devs.map(d => `<tr><td><b>ПК ${d.computer_no}</b></td><td><code class="host-big">${esc(d.name || '—')}</code></td><td>${!d.online ? '— не запущено' : d.locked ? '🔒 заблокований' : '🔓 відкритий'}</td>
        <td>${d.online ? '🟢 онлайн' : '⚪ ' + (d.last_seen ? fmtDate(d.last_seen, true) : '—')}</td>
        <td class="row-actions"><button class="btn sm" data-cmd="lock" data-id="${d.id}">🔒</button><button class="btn sm" data-cmd="unlock" data-id="${d.id}">🔓</button><button class="btn sm" data-cmd="exit" data-id="${d.id}" title="Закрити кіоск">⏏</button>
        <button class="btn sm ghost" data-off="${d.id}" title="Код, що працює без інтернету">📴 офлайн-код</button><button class="btn sm ghost" data-deld="${d.id}">🗑</button></td></tr>`).join('') || '<tr><td colspan=5 class="muted">Ще немає. Встановіть кіоск-клієнт на ПК (див. README → «Кіоск»).</td></tr>'}
      </tbody></table></section>
    <section class="card"><h3>Журнал входів учнів</h3>
      <table class="tbl compact"><thead><tr><th>Час</th><th>Учень</th><th>Клас</th><th>Звідки</th><th>Клієнт</th></tr></thead><tbody>
      ${logins.slice(0, 100).map(l => `<tr><td>${fmtDate(l.at, true)}</td><td><a href="#/student/${l.user_id}">${esc(l.name)}</a></td><td>${esc(l.class_name || '')}</td><td>${l.place === 'home' ? '🏠 поза класом' : '🏫 ПК ' + l.computer_no + (l.host ? ' · ' + esc(l.host) : '')}</td><td class="muted">${esc(l.client)} ${esc(l.ip || '')}</td></tr>`).join('')}</tbody></table></section>`, '#/devices');
  const gen = async kind => {
    const r = await api('/unlock-codes', { body: { kind } });
    $('#code').innerHTML = `<div class="pw-big">${r.code}</div><p class="muted">${kind === 'exit' ? 'Закриває кіоск (обслуговування ПК).' : 'Розблоковує один ПК.'} Одноразовий, діє до ${fmtDate(r.expires_at, true)}.</p>`;
  };
  $('#gen').onclick = () => gen('unlock'); $('#genx').onclick = () => gen('exit');
  $('#lockall').onclick = async () => { await api('/devices/command', { body: { cmd: 'lock' } }); toast('Заблоковано'); render(); };
  $('#exitall').onclick = async () => { if (!confirm('Закрити кіоск на всіх комп\'ютерах?')) return; await api('/devices/command', { body: { cmd: 'exit' } }); toast('Кіоски закриваються'); setTimeout(render, 1500); };
  $('#unlockall').onclick = async () => { await api('/devices/command', { body: { cmd: 'unlock' } }); toast('Розблоковано'); render(); };
  $$('[data-cmd]', main).forEach(b => b.onclick = async () => { await api('/devices/command', { body: { cmd: b.dataset.cmd, ids: [+b.dataset.id] } }); render(); });
  $$('[data-off]', main).forEach(b => b.onclick = async () => { const r = await api(`/devices/${b.dataset.off}/offline-code`, { body: {} }); modal(`<h3>Офлайн-код для ПК ${r.computer_no}</h3><div class="pw-big">${r.code}</div><p class="muted">Працює навіть без інтернету, один раз.</p>`); });
  $$('[data-deld]', main).forEach(b => b.onclick = async () => { if (confirm('Видалити пристрій? Кіоск треба буде зареєструвати знову.')) { await del('/devices/' + b.dataset.deld); render(); } });
  onLeave(listen('live', debounce(e => { if (location.hash === '#/devices') render(); }, 800)));
}

async function settingsPage() {
  const s = await api('/settings');
  const main = shellFn(`<h1>⚙️ Налаштування</h1>
    <section class="card"><h3>Комп'ютерний клас</h3>
      <label>Кількість комп'ютерів (лише підказка — система питає щоразу, коли ви починаєте урок)<input type="number" id="pcs" min="1" max="60" value="${s.computers}"></label>
      <label>Заборонені програми (кіоск закриває їх під час уроку; по одній назві процесу в рядку; Windows — <code>chrome.exe</code>, Linux — <code>chrome</code>, <code>firefox</code>)<textarea id="ba" rows="6" class="mono">${esc(s.blocked_apps.join('\n'))}</textarea></label>
      <label>Термін дії одноразового коду, хв<input type="number" id="ttl" value="${s.unlock_ttl}"></label>
      <label class="switch"><input type="checkbox" id="cke" ${s.close_kiosk_on_end ? 'checked' : ''}> Закривати кіоск на всіх ПК після «Завершити урок» (комп'ютери звільняються для інших вчителів)</label><br><br>
      <button class="btn primary" id="sv">Зберегти</button></section>
    <section class="card"><h3>Номер цього комп'ютера (для входу з браузера без кіоску)</h3>
      <p class="muted">Відкрийте цю сторінку на кожному учнівському ПК один раз і вкажіть номер. Тоді система знатиме, хто за яким комп'ютером.</p>
      <div class="row"><input id="pcno" type="number" placeholder="напр. 5" value="${esc(localStorage.getItem('pcNo') || '')}"><button class="btn" id="svpc">Зберегти для цього браузера</button><button class="btn ghost" id="clpc">Це не класний ПК</button></div></section>
    <section class="card"><h3>Пароль вчителя</h3>
      <div class="row wrap"><input type="password" id="op" placeholder="Старий пароль"><input type="password" id="np" placeholder="Новий пароль"><button class="btn" id="cp">Змінити</button></div></section>`, '#/settings');
  $('#sv').onclick = async () => { await put('/settings', { computers: +$('#pcs').value, blocked_apps: $('#ba').value.split('\n'), unlock_ttl: +$('#ttl').value, close_kiosk_on_end: $('#cke').checked }); toast('Збережено'); };
  $('#svpc').onclick = () => { localStorage.setItem('pcNo', $('#pcno').value); toast('Цей браузер тепер — ПК ' + $('#pcno').value); };
  $('#clpc').onclick = () => { localStorage.removeItem('pcNo'); $('#pcno').value = ''; toast('Номер ПК очищено'); };
  $('#cp').onclick = async () => { await api('/me/password', { body: { old: $('#op').value, password: $('#np').value } }); toast('Пароль змінено'); };
}
