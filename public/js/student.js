// Кабінет учня
import { state, api, $, $$, esc, md, route, render, toast, modal, fmtDate, STATES, onLeave, beep } from './core.js';
import { initStudentDemo, applyMode } from './demo.js';

let shellFn = null;
let cur = null;          // поточний урок на екрані
let showAll = localStorage.getItem('showAllSteps') === '1';
let pipWin = null;

export function registerStudent(shell) {
  shellFn = shell;
  route('/', homePage);
  route('/lesson/:id', lessonPage);
  route('/mini/:id', miniPage);
  route('/homework', homeworkPage);
  route('/grades', gradesPage);
  route('/criteria', criteriaPage);
  route('/training', trainingPage);
}

export function onStudentSocket(s) {
  initStudentDemo(s);
  s.on('session', () => { if (['#/', ''].includes(location.hash)) render(); else if (cur) reloadLesson(); });
  s.on('seat', r => { toast(`Твоє місце: ПК ${r.computer_no}, ${r.role === 'driver' ? '⌨️ ти за клавіатурою' : '🧭 ти штурман (підказуєш і перевіряєш)'}`, 'info', 8000); if (cur) reloadLesson(); });
  s.on('group:changed', () => cur && reloadLesson());
  s.on('progress', ({ step_id, done }) => {
    if (!cur) return;
    const st = cur.steps.find(x => x.id === step_id);
    if (st) { st.done = done ? (st.done || { via: 'group' }) : null; drawSteps(); }
  });
  s.on('help:answered', ({ step_id, explanation }) => {
    beep();
    toast('💡 Вчитель надіслав пояснення!', 'info', 8000);
    const st = cur?.steps.find(x => x.id === step_id);
    if (st) { st.explanations = (st.explanations || 0) + 1; drawSteps(); }
    showAnswer(step_id, explanation);
  });
  // Вчитель відкриває посилання на всіх ПК (тест тощо)
  s.on('open:url', d => {
    if (d.pcs && !d.pcs.includes(+state.pc)) return;
    if (state.kiosk?.openUrl) { state.kiosk.openUrl(d); toast('🔗 Вчитель відкрив: ' + (d.title || d.url), 'info', 5000); return; }
    const w = window.open(d.url, '_blank');
    if (w) { try { w.opener = null; } catch {} toast('🔗 Вчитель відкрив посилання в новій вкладці', 'info'); return; }
    const m = modal(`<h3>🔗 Вчитель надіслав посилання</h3>${d.title ? `<p><b>${esc(d.title)}</b></p>` : ''}
      <p class="muted" style="word-break:break-all">${esc(d.url)}</p>
      <a class="btn big primary" href="${esc(d.url)}" target="_blank" rel="noopener" id="go-url">Відкрити →</a>`);
    $('#go-url', m.el).onclick = () => setTimeout(m.close, 100);
  });
  s.on('url:close', d => state.kiosk?.closeUrl?.(d.id || null));
  // Вчитель надіслав файли для роботи — копіюємо в робочу папку
  s.on('files:new', async d => {
    beep();
    toast(`📂 Вчитель надіслав файли: ${d.names.join(', ')}`, 'info', 7000);
    if (cur?.id === d.lesson_id) { await reloadLesson(); await prepareFolder(); drawWork(); }
  });
  s.on('explanation:new', ({ lesson_id, step_id }) => {
    if (cur?.id === lesson_id) { const st = cur.steps.find(x => x.id === step_id); if (st && !$('.modal')) { reloadLesson(); } }
  });
  // Поточний режим заняття при підключенні
  s.on('connect', async () => {
    try { const h = await api('/student/home'); if (h.session && h.session.mode !== 'work') applyMode(h.session.mode, h.session.id); } catch {}
  });
}

const stateBadge = (st, withLabel = false) => {
  const d = STATES[st?.state || 'none'];
  return `<span class="st ${d.cls}" title="${esc(d.label)}">${d.icon}${withLabel ? ' ' + esc(d.label) : ''}</span>`;
};

// =====================================================================
// Мій шлях (навчальна траєкторія)
// =====================================================================
async function homePage() {
  cur = null;
  const d = await api('/student/home');
  const all = d.course ? d.course.units.flatMap(u => u.lessons) : [];
  const doneCount = all.filter(l => ['mastered', 'done_self', 'done_group'].includes(l.status?.state)).length;
  const pct = all.length ? Math.round(doneCount / all.length * 100) : 0;
  const s = d.session;
  const main = shellFn(`
    <div class="hello">
      <h1>Привіт, ${esc(d.me.name.split(' ')[1] || d.me.name)}! 👋</h1>
      <p class="muted">${esc(d.cls?.name || '')} · ${esc(d.course?.title || 'курс ще не призначено')}</p>
    </div>
    ${s ? `<div class="now-card">
        <div><div class="label">🔴 Зараз урок</div><h2>${esc(s.title || '')}</h2>
        ${s.seat ? `<p>ПК <b>${s.seat.computer_no}</b> · ${s.seat.role === 'driver' ? '⌨️ <b>ти за клавіатурою</b>' : '🧭 <b>ти штурман</b> — читай кроки вголос і перевіряй'}
          ${s.seat.mates.length ? '· разом з: ' + s.seat.mates.map(m => esc(m.name)).join(', ') : ''}</p>` : s.pc ? `<p>ПК ${esc(s.pc)}</p>` : '<p class="muted">Ти не в класі — можеш працювати над уроком вдома.</p>'}
        </div>
        <a class="btn big primary" href="#/lesson/${s.lesson_id}">До роботи →</a></div>` : ''}
    <div class="grid2">
      <section class="card">
        <h3>📈 Мій прогрес</h3>
        <div class="progress big"><div style="width:${pct}%"></div><span>${pct}%</span></div>
        <p class="muted">${doneCount} з ${all.length} уроків виконано</p>
        ${d.training_due ? `<a class="btn" href="#/training">🧠 Повторити: ${d.training_due} питань чекають</a>` : '<a class="btn ghost" href="#/training">🧠 Тренування</a>'}
      </section>
      <section class="card ${d.debts.length ? 'warn' : ''}">
        <h3>🎯 Треба наздогнати</h3>
        ${d.debts.length ? '<ul class="debts">' + d.debts.map(id => { const l = all.find(x => x.id === id); return `<li><a href="#/lesson/${id}">${stateBadge(l.status)} ${esc(l.title)}</a> <small class="muted">${l.status.state === 'done_group' ? 'виконав у групі — спробуй сам' : esc(STATES[l.status.state].label)}</small></li>`; }).join('') + '</ul><p class="hint">Пропустив урок чи урок зірвала тривога? Виконай практичну вдома — вона зарахується.</p>'
    : '<p class="ok-text">Усе виконано — так тримати! 🎉</p>'}
      </section>
    </div>
    ${d.homework.filter(h => !h.submitted).length ? `<section class="card"><h3>🏠 Домашнє завдання</h3>${d.homework.filter(h => !h.submitted).slice(0, 3).map(h => `<div class="hw-row"><b>${esc(h.lesson_title || 'Завдання')}</b>${h.due ? ` <span class="due">до ${fmtDate(h.due)}</span>` : ''}<div>${md(h.text)}</div></div>`).join('')}<a href="#/homework">Усі завдання →</a></section>` : ''}
    <h2 class="section-title">🧭 Моя навчальна траєкторія</h2>
    <p class="muted">Що ми вивчаємо, навіщо це потрібно і де ти зараз.</p>
    <div class="path">
      ${(d.course?.units || []).map((u, ui) => `
        <section class="unit">
          <div class="unit-head"><span class="unit-n">${ui + 1}</span><div><h3>${esc(u.title)}</h3>
            ${u.goal ? `<p><b>Що вчимо:</b> ${esc(u.goal)}</p>` : ''}${u.why ? `<p><b>Навіщо:</b> ${esc(u.why)}</p>` : ''}</div></div>
          <ol class="lessons">${u.lessons.map(l => `
            <li class="${STATES[l.status?.state || 'none'].cls}"><a href="#/lesson/${l.id}">
              ${stateBadge(l.status)} <span class="lt">${esc(l.title)}</span>
              ${l.status?.total ? `<span class="mini-prog" title="Виконано кроків">${l.status.self + l.status.group}/${l.status.total}</span>` : ''}
              ${l.objectives ? `<small>Навчишся: ${esc(l.objectives)}</small>` : ''}</a></li>`).join('')}</ol>
        </section>`).join('')}
    </div>
    <div class="legend">${Object.values(STATES).map(s => `<span><span class="st ${s.cls}">${s.icon}</span> ${s.label}</span>`).join('')}</div>
  `, '#/');
  if (s && s.mode !== 'work') applyMode(s.mode, s.id);
  return main;
}

// =====================================================================
// Урок: цілі, матеріали, інструкційна картка, завершення
// =====================================================================
async function lessonPage(id) {
  cur = await api('/lessons/' + id);
  const l = cur;
  const crit = l.success_criteria.split('\n').map(s => s.trim()).filter(Boolean);
  const meRole = l.group?.find(g => g.id === state.user.id)?.role;
  shellFn(`
    <div class="crumbs"><a href="#/">Мій шлях</a> › ${esc(l.unit_title)}</div>
    <h1>${esc(l.title)}</h1>
    ${l.session ? `<div class="group-bar">💻 ПК ${l.session.pc} ·
      ${l.group?.length > 1 ? `Група: ${l.group.map(g => `<span class="${g.role}">${g.role === 'driver' ? '⌨️' : '🧭'} ${esc(g.name)}</span>`).join(' ')}
      <br><small>${meRole === 'driver' ? 'Ти за клавіатурою: виконуй кроки. Штурмани читають інструкцію і перевіряють.' : 'Ти штурман: читай крок уголос, слідкуй, щоб водій нічого не пропустив. Потім поміняєтеся.'}</small>` : 'Працюєш самостійно'}
      </div>` : `<div class="group-bar home">🏠 Самостійна робота — прогрес зараховується лише тобі</div>`}
    <section class="goals">
      ${l.objectives ? `<div class="goal"><div class="gi">🎯</div><div><b>Сьогодні я навчуся</b><p>${esc(l.objectives)}</p></div></div>` : ''}
      ${l.why ? `<div class="goal"><div class="gi">💡</div><div><b>Навіщо це мені</b><p>${esc(l.why)}</p></div></div>` : ''}
      ${crit.length ? `<div class="goal"><div class="gi">✅</div><div><b>Критерії успіху — я зможу:</b><ul>${crit.map(c => `<li>${esc(c)}</li>`).join('')}</ul></div></div>` : ''}
    </section>
    ${l.theory || l.materials.length ? `<details class="card" ${l.steps.some(s => s.done) ? '' : 'open'}><summary><h3>📖 Матеріали уроку</h3></summary>
      <div class="theory">${md(l.theory)}</div>
      <div class="materials">${l.materials.map(materialHtml).join('')}</div></details>` : ''}
    ${l.links?.length ? `<section class="card"><h3>🔗 Посилання від вчителя</h3>${l.links.map(k => `<div class="link-row"><button class="btn sm" data-url="${k.id}">Відкрити</button> <b>${esc(k.title || '')}</b> <span class="muted small" style="word-break:break-all">${esc(k.url)}</span> <small class="muted">${fmtDate(k.created_at, true)}</small></div>`).join('')}</section>` : ''}
    <section class="card" id="workbox"></section>
    <section class="card work">
      <div class="work-head">
        <h3>🛠 Практична робота</h3>
        <div class="work-tools">
          <label class="switch"><input type="checkbox" id="showall" ${showAll ? 'checked' : ''}> усі кроки</label>
          <button class="btn sm" id="pin">📌 Поверх усіх вікон</button>
        </div>
      </div>
      <div class="progress"><div id="pbar"></div><span id="ptext"></span></div>
      <div id="steps"></div>
    </section>
    <section class="card" id="finish"></section>
    ${l.homework_list?.length ? `<section class="card"><h3>🏠 Домашнє завдання</h3>${l.homework_list.map(h => `<div class="hw-row">${md(h.text)}${h.due ? `<span class="due">до ${fmtDate(h.due)}</span>` : ''} ${h.submitted ? '<span class="ok-text">✓ здано</span>' : `<a href="#/homework">Здати →</a>`}</div>`).join('')}</section>` : ''}
  `, '');
  $('#showall').onchange = e => { showAll = e.target.checked; localStorage.setItem('showAllSteps', showAll ? '1' : '0'); drawSteps(); };
  $('#pin').onclick = openPinned;
  $$('[data-url]').forEach(b => b.onclick = () => {
    const k = l.links.find(x => x.id === +b.dataset.url);
    if (state.kiosk?.openUrl) state.kiosk.openUrl({ id: 'my-' + k.id, url: k.url, title: k.title }); else window.open(k.url, '_blank');
  });
  drawSteps();
  drawWork();
  let sync = null;
  if (state.kiosk?.folder) {
    prepareFolder().then(drawWork).catch(e => console.warn(e));
    // Автосинхронізація: вчитель бачить актуальні документи учня ще до «Я закінчив»
    sync = setInterval(() => { if (cur?.id === l.id) sendFolderResults('quiet').then(n => n && drawWork()).catch(() => {}); }, 60000);
  }
  onLeave(() => { cur = null; if (sync) clearInterval(sync); });
}
async function reloadLesson() {
  if (!cur) return;
  const id = cur.id;
  const fresh = await api('/lessons/' + id);
  if (cur?.id === id) { fresh.folderPath = cur.folderPath; cur = fresh; if (location.hash.startsWith('#/mini/')) drawMini(); else { drawSteps(); drawWork(); } }
}

function materialHtml(m) {
  const t = esc(m.title || 'Матеріал');
  if (m.kind === 'video' || /^video/.test(m.mime || '')) return `<div class="mat"><b>🎬 ${t}</b><video src="${esc(m.url)}" controls preload="metadata"></video></div>`;
  if (m.kind === 'image' || /^image/.test(m.mime || '')) return `<div class="mat"><b>🖼 ${t}</b><img src="${esc(m.url)}" class="zoomable"></div>`;
  if (m.kind === 'link' && /youtu/.test(m.url)) {
    const vid = (/(?:v=|youtu\.be\/|embed\/)([\w-]{11})/.exec(m.url) || [])[1];
    if (vid) return `<div class="mat"><b>🎬 ${t}</b><iframe class="yt" src="https://www.youtube-nocookie.com/embed/${vid}" allowfullscreen></iframe></div>`;
  }
  const icon = { presentation: '📽', card: '📋', file: '📎', link: '🔗' }[m.kind] || '📎';
  return `<a class="mat-link" href="${esc(m.url)}" target="_blank" rel="noopener">${icon} ${t}</a>`;
}

function stepsStats() {
  const total = cur.steps.length, done = cur.steps.filter(s => s.done).length;
  const curIdx = cur.steps.findIndex(s => !s.done);
  return { total, done, curIdx };
}

function stepHtml(s, i, curIdx) {
  const isCur = i === curIdx;
  const cls = s.done ? 'done' : isCur ? 'current' : i > curIdx ? 'next' : '';
  return `<div class="step ${cls}" data-id="${s.id}">
    <label class="chk"><input type="checkbox" ${s.done ? 'checked' : ''} data-step="${s.id}"><span></span></label>
    <div class="step-body"><div class="step-n">Крок ${i + 1}${s.done?.via === 'group' ? ' <small title="Зараховано у групі">👥</small>' : ''}</div>
      <div class="step-text">${md(s.text)}</div></div>
    <button class="btn help-btn" data-help="${s.id}" title="Отримати пояснення">❓ Пояснення${s.explanations ? ` <b>${s.explanations}</b>` : ''}</button>
  </div>`;
}

function drawSteps() {
  if (!cur || !$('#steps')) { drawMini(); return; }
  const { total, done, curIdx } = stepsStats();
  $('#pbar').style.width = (total ? done / total * 100 : 0) + '%';
  $('#ptext').textContent = `${done} / ${total}`;
  let html;
  if (showAll || curIdx === -1) html = cur.steps.map((s, i) => stepHtml(s, i, curIdx)).join('');
  else {
    // Покроковий режим: виконані згорнуті, поточний великий, наступні лише заголовком
    const doneBefore = cur.steps.slice(0, curIdx);
    html = (doneBefore.length ? `<details class="done-list"><summary>✅ Виконано кроків: ${doneBefore.length}</summary>${doneBefore.map((s, i) => stepHtml(s, i, curIdx)).join('')}</details>` : '')
      + stepHtml(cur.steps[curIdx], curIdx, curIdx)
      + (curIdx < total - 1 ? `<div class="next-hint">Далі ще ${total - curIdx - 1} крок(ів). Постав ✓, коли виконаєш цей.</div>` : '');
    html += cur.steps.slice(curIdx + 1).filter(s => s.done).map(s => stepHtml(s, cur.steps.indexOf(s), curIdx)).join('');
  }
  $('#steps').innerHTML = total ? html : '<p class="muted">У цьому уроці немає практичної роботи.</p>';
  bindStepEvents($('#steps'));
  drawFinish();
  drawMini();
}

function bindStepEvents(root) {
  $$('input[data-step]', root).forEach(cb => cb.onchange = () => toggleStep(+cb.dataset.step, cb.checked));
  $$('[data-help]', root).forEach(b => b.onclick = () => helpPopup(+b.dataset.help));
}

async function toggleStep(stepId, done) {
  const st = cur.steps.find(s => s.id === stepId);
  st.done = done ? { via: 'self' } : null;
  drawSteps();
  try {
    const r = await api('/progress', { body: { step_id: stepId, done } });
    if (done && r.group > 1) toast(`Зараховано всій групі (${r.group})`, 'ok', 2000);
  } catch { st.done = done ? null : { via: 'self' }; drawSteps(); }
}

// ---------- Пояснення до кроку ----------
async function helpPopup(stepId) {
  const d = await api(`/steps/${stepId}/explanations`);
  const idx = cur ? cur.steps.findIndex(s => s.id === stepId) : -1;
  const open = d.my_requests.find(r => r.status === 'open');
  const m = modal(`
    <h3>❓ Пояснення до кроку ${idx + 1}</h3>
    <div class="quote">${md(d.step.text)}</div>
    ${d.explanations.length ? `<p class="muted">Ці пояснення вже допомогли іншим. Оціни зірочками, яке найкорисніше ⭐</p>
      <div class="ex-list">${d.explanations.map(e => `
        <div class="ex"><div class="ex-text">${md(e.text)}</div>
          <div class="ex-foot"><span class="stars" data-ex="${e.id}">${[1, 2, 3, 4, 5].map(n => `<button data-v="${n}" class="${n <= (e.mine || 0) ? 'on' : ''}">★</button>`).join('')}</span>
          <small>${e.votes ? `★ ${(+e.avg).toFixed(1)} (${e.votes})` : 'ще без оцінок'} · ${fmtDate(e.created_at)}</small></div></div>`).join('')}</div>`
    : '<p class="muted">До цього кроку ще немає пояснень. Запитай вчителя — він відповість прямо сюди.</p>'}
    <div class="ask">
      ${open ? `<p class="wait">⏳ Ти вже запитав${open.question ? ': «' + esc(open.question) + '»' : ''}. Вчитель скоро відповість — пояснення з'явиться тут.</p>` : `
      <b>Все одно незрозуміло?</b>
      <textarea id="q" rows="2" placeholder="Що саме незрозуміло? (необов'язково)"></textarea>
      <button class="btn primary" id="ask">🙋 Запитати вчителя</button>`}
    </div>
    ${d.my_requests.filter(r => r.status !== 'open').length ? `<details><summary>Мої минулі запитання (${d.my_requests.filter(r => r.status !== 'open').length})</summary>
      <ul>${d.my_requests.filter(r => r.status !== 'open').map(r => `<li>${fmtDate(r.created_at, true)} — ${esc(r.question || 'без тексту')} ✓</li>`).join('')}</ul></details>` : ''}
  `);
  $$('.stars', m.el).forEach(box => $$('button', box).forEach(b => b.onclick = async () => {
    await api(`/explanations/${box.dataset.ex}/star`, { body: { value: +b.dataset.v } });
    $$('button', box).forEach(x => x.classList.toggle('on', +x.dataset.v <= +b.dataset.v));
    toast('Дякуємо за оцінку!', 'ok', 1500);
  }));
  const ask = $('#ask', m.el);
  if (ask) ask.onclick = async () => {
    await api('/help', { body: { step_id: stepId, question: $('#q', m.el).value } });
    toast('Запит надіслано вчителю 🙋', 'ok');
    m.close();
  };
}
function showAnswer(stepId, ex) {
  $('.modal-bg')?.remove();
  const idx = cur ? cur.steps.findIndex(s => s.id === stepId) : -1;
  const m = modal(`<h3>💡 Пояснення від вчителя${idx >= 0 ? ' до кроку ' + (idx + 1) : ''}</h3>
    <div class="ex big">${md(ex.text)}</div>
    <p class="muted">Допомогло? Оціни, щоб інші учні бачили найкращі пояснення:</p>
    <div class="stars big" data-ex="${ex.id}">${[1, 2, 3, 4, 5].map(n => `<button data-v="${n}">★</button>`).join('')}</div>`);
  $$('.stars button', m.el).forEach(b => b.onclick = async () => {
    await api(`/explanations/${ex.id}/star`, { body: { value: +b.dataset.v } });
    toast('Дякую! ⭐', 'ok', 1500); m.close();
  });
}

// =====================================================================
// Робоча папка: файли для роботи від вчителя + мої результати
// =====================================================================
const folderKey = () => ({ student: state.user.name, lesson: cur.title });
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(n / 1024)) + ' КБ';
function workName(m) {
  let n = m.title || 'файл';
  const ext = (/\.[a-z0-9]{1,6}$/i.exec(m.url || '') || [''])[0];
  if (!/\.[a-z0-9]{1,6}$/i.test(n) && ext) n += ext;
  return n;
}
// Кіоск: створити папку й скопіювати туди файли для роботи (наявні файли не перезаписуються)
async function prepareFolder() {
  if (!state.kiosk?.folder || !cur) return;
  const info = await state.kiosk.folder.info(folderKey());
  cur.folderPath = info.path;
  for (const m of cur.workfiles || []) {
    const name = workName(m);
    if (info.files.includes(name)) continue;
    const r = await fetch(m.url, { credentials: 'same-origin' });
    if (!r.ok) continue;
    await state.kiosk.folder.write({ ...folderKey(), name, data: new Uint8Array(await r.arrayBuffer()) });
  }
}
async function uploadResults(items, finishing) {
  const fd = new FormData();
  items.forEach(i => fd.append('files', i.blob || new Blob([i.data]), i.name));
  if (finishing === 'quiet') fd.append('quiet', '1'); else if (finishing) fd.append('finishing', '1');
  const r = await api(`/lessons/${cur.id}/my-files`, { body: fd });
  cur.my_files = r.files;
  return r;
}
// Кіоск: зібрати нові/змінені файли з папки й надіслати
async function sendFolderResults(finishing) {
  const items = await state.kiosk.folder.collect(folderKey());
  const fresh = items.filter(i => !i.sent);
  if (fresh.length) {
    await uploadResults(fresh, finishing);
    await state.kiosk.folder.markSent({ ...folderKey(), files: fresh.map(({ name, size, mtimeMs }) => ({ name, size, mtimeMs })) });
  }
  return fresh.length;
}
const pendingIds = () => (cur.my_files || []).filter(f => !f.submission_id && f.author === state.user.name).map(f => f.id);

function drawWork() {
  const box = $('#workbox'); if (!box || !cur) return;
  const kiosk = !!state.kiosk?.folder;
  const wf = cur.workfiles || [], mine = cur.my_files || [];
  // не губимо файли, які учень уже вибрав у формі (розділ може оновитися, коли вчитель надсилає файли)
  const keepForm = $('#up-form', box);
  const keep = keepForm && keepForm.querySelector('input[type=file]').files.length ? keepForm : null;
  const shortPath = cur.folderPath ? cur.folderPath.split(/[\\/]/).slice(-4).join(' › ') : '';
  box.innerHTML = `<div class="work-head"><h3>📂 Моя робоча папка</h3>
      ${kiosk ? `<button class="btn primary" id="open-folder">📂 Відкрити папку</button>` : ''}</div>
    ${kiosk && shortPath ? `<p class="folder-path">📁 ${esc(shortPath)}</p>` : ''}
    ${wf.length ? `<p><b>Файли для роботи</b> ${kiosk ? '<span class="muted small">— уже скопійовані у твою папку</span>' : '<span class="muted small">— завантаж і відкрий</span>'}</p>
      <div class="files">${wf.map(m => kiosk ? `<span class="file">📄 ${esc(workName(m))}</span>` : `<a class="file" href="${esc(m.url)}" download="${esc(workName(m))}">⬇ ${esc(workName(m))}</a>`).join('')}</div>` : ''}
    <p><b>Мої результати</b> ${mine.length ? '' : '<span class="muted small">— ще нічого не надіслано</span>'}</p>
    ${mine.length ? `<div class="files">${mine.map(f => `<span class="file ${f.submission_id ? 'done' : ''}">${f.submission_id ? '✅' : '📤'} <a href="/api/files/${f.id}">${esc(f.name)}</a> <small>${fmtSize(f.size)}${f.author !== state.user.name ? ' · ' + esc(f.author) : ''}</small>
      ${!f.submission_id && f.author === state.user.name ? `<button class="x" data-delfile="${f.id}" title="Прибрати">✕</button>` : ''}</span>`).join('')}</div>` : ''}
    ${kiosk ? `<div class="row wrap"><button class="btn" id="send-folder">📤 Надіслати нові файли з папки</button></div>
      <p class="hint">Зберігай свою роботу <b>у цю папку</b> (Файл → Зберегти як → Документи › InfoKlas). Вчитель бачить твою папку: файли надсилаються самі щохвилини і коли ти натиснеш «Я закінчив».</p>`
    : `<form id="up-form" class="row wrap"><input type="file" name="files" multiple required><button class="btn">📤 Надіслати вчителю</button></form>
      <p class="hint">Працюєш вдома? Завантаж файли для роботи, виконай завдання і надішли результат тут.</p>`}`;
  if (keep) $('#up-form', box)?.replaceWith(keep);
  $('#open-folder', box)?.addEventListener('click', async () => { await prepareFolder(); state.kiosk.folder.open(folderKey()); });
  $('#send-folder', box)?.addEventListener('click', async () => {
    const n = await sendFolderResults(false);
    toast(n ? `Надіслано файлів: ${n}` : 'У папці немає нових чи змінених файлів', n ? 'ok' : 'info'); drawWork();
  });
  $('#up-form', box)?.addEventListener('submit', async e => {
    e.preventDefault();
    const files = [...e.target.files.files].map(f => ({ name: f.name, blob: f }));
    await uploadResults(files, false); toast('Файли надіслано вчителю'); drawWork();
  });
  $$('[data-delfile]', box).forEach(b => b.onclick = async () => {
    await api('/my-files/' + b.dataset.delfile, { method: 'DELETE' });
    cur.my_files = cur.my_files.filter(f => f.id !== +b.dataset.delfile); drawWork();
  });
}

// ---------- Завершення: самооцінювання, рефлексія, скриншот ----------
function drawFinish() {
  const box = $('#finish'); if (!box || !cur) return;
  const { total, done } = stepsStats();
  const crit = cur.success_criteria.split('\n').map(s => s.trim()).filter(Boolean);
  if (cur.my?.finished_at) {
    box.innerHTML = `<h3>🏁 Роботу здано ${fmtDate(cur.my.finished_at, true)}</h3>
      ${cur.my.mastery === 1 ? '<p class="ok-text">⭐ Вчитель підтвердив: ти це вмієш!</p>' : cur.my.mastery === 0 ? '<p class="warn-text">⚠️ Вчитель радить ще потренуватися — переглянь кроки та пояснення.</p>' : '<p class="muted">Вчитель перевірить роботу.</p>'}
      <button class="btn ghost" id="refinish">Надіслати ще раз</button>`;
    $('#refinish').onclick = () => { cur.my.finished_at = null; drawFinish(); };
    return;
  }
  const ready = total === 0 || done === total;
  box.innerHTML = `<h3>🏁 Завершення роботи</h3>
    ${!ready ? `<p class="muted">Виконай усі кроки (${done}/${total}), а потім оціни себе і натисни «Я закінчив».</p>` : ''}
    <div class="${ready ? '' : 'dim'}">
    ${crit.length ? `<p><b>Оціни себе чесно</b> — це допоможе вчителю зрозуміти, кому потрібна допомога:</p>
      <div class="self">${crit.map((c, i) => `<div class="self-row"><span>${esc(c)}</span>
        <span class="tl" data-i="${i}"><button data-v="2" title="Можу">🟢</button><button data-v="1" title="Не впевнений">🟡</button><button data-v="0" title="Ще не можу">🔴</button></span></div>`).join('')}</div>` : ''}
    <label>Що було найскладніше? Що нового дізнався? <textarea id="refl" rows="2"></textarea></label>
    <button class="btn big primary" id="fin" ${ready ? '' : 'disabled'}>✅ Я закінчив — надіслати вчителю</button>
    <p class="hint">Буде зроблено знімок екрана з твоїм результатом.</p></div>`;
  const sa = {};
  $$('.tl', box).forEach(t => $$('button', t).forEach(b => b.onclick = () => { sa[crit[t.dataset.i]] = +b.dataset.v; $$('button', t).forEach(x => x.classList.toggle('on', x === b)); }));
  const fin = $('#fin');
  if (fin) fin.onclick = () => finishWork(sa, $('#refl').value);
}

export async function captureScreen() {
  if (state.kiosk?.capture) { await new Promise(r => setTimeout(r, 350)); return state.kiosk.capture(); }
  if (!navigator.mediaDevices?.getDisplayMedia) return null;
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'monitor' }, audio: false, selfBrowserSurface: 'exclude' });
  try {
    const v = document.createElement('video');
    v.srcObject = stream; v.muted = true; await v.play();
    await new Promise(r => setTimeout(r, 400));
    const c = document.createElement('canvas');
    const scale = Math.min(1, 1600 / v.videoWidth);
    c.width = v.videoWidth * scale; c.height = v.videoHeight * scale;
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.75);
  } finally { stream.getTracks().forEach(t => t.stop()); }
}
function fileToDataUrl(file) {
  return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
}

async function finishWork(selfAssess, reflection) {
  const m = modal(`<h3>📸 Знімок екрана</h3>
    <p>${state.kiosk ? 'Зараз буде зроблено знімок екрана.' : 'Обери <b>«Весь екран»</b> у вікні, що з\'явиться — система зробить один знімок твого результату.'}</p>
    <p class="muted">Переконайся, що твоя робота (документ, програма) відкрита на екрані.</p>
    <div id="fin-files" class="fin-files"></div>
    <div class="row"><button class="btn primary big" id="shot">📸 Зробити знімок</button>
      <label class="btn ghost">🖼 Завантажити файл<input type="file" accept="image/*" id="shotfile" hidden></label></div>
    <div id="preview"></div>`);
  let data = null;
  // які файли піде вчителю разом із роботою
  (async () => {
    const box = $('#fin-files', m.el); if (!box) return;
    let names = [];
    if (state.kiosk?.folder) { await prepareFolder(); names = (await state.kiosk.folder.collect(folderKey())).map(i => i.name); }
    else names = (cur.my_files || []).filter(f => !f.submission_id).map(f => f.name);
    box.innerHTML = names.length ? `📎 Разом з роботою вчитель отримає файли: <b>${names.map(esc).join(', ')}</b>`
      : `<span class="warn-text">⚠️ ${state.kiosk?.folder ? 'У твоїй робочій папці немає нових файлів.' : 'Ти ще не надіслав файлів з результатом.'}</span>
         ${state.kiosk?.folder ? '<button class="btn sm" id="fin-open">📂 Відкрити папку</button> Збережи туди роботу, якщо вона є.' : 'Якщо результат — файл, надішли його в розділі «Моя робоча папка».'}`;
    $('#fin-open', box)?.addEventListener('click', () => state.kiosk.folder.open(folderKey()));
  })().catch(() => {});
  const showPreview = () => {
    $('#preview', m.el).innerHTML = `<img src="${data}" class="shot-prev"><button class="btn big primary" id="send">✅ Надіслати вчителю</button>`;
    $('#send', m.el).onclick = send;
  };
  const send = async () => {
    if (state.kiosk?.folder) { try { await sendFolderResults(true); } catch (e) { toast('Файли з папки не вдалося надіслати: ' + e.message, 'err'); } }
    const r = await api('/finish', { body: { lesson_id: cur.id, screenshot: data, self_assess: selfAssess, reflection, file_ids: pendingIds() } });
    reloadLesson().catch(() => {});
    m.close();
    toast('Роботу надіслано вчителю! 🎉', 'ok', 5000);
    cur.my = { ...cur.my, finished_at: new Date().toISOString() };
    drawFinish();
    return r;
  };
  $('#shot', m.el).onclick = async () => {
    try {
      if (state.kiosk) state.kiosk.setLayout?.('hide-for-shot');
      data = await captureScreen();
      if (state.kiosk) state.kiosk.setLayout?.('work');
      if (data) showPreview(); else toast('Не вдалося зробити знімок — завантаж файл', 'err');
    } catch { toast('Знімок скасовано. Можна завантажити файл зі скриншотом.', 'err'); }
  };
  $('#shotfile', m.el).onchange = async e => { if (e.target.files[0]) { data = await fileToDataUrl(e.target.files[0]); showPreview(); } };
}

// ---------- Режим "поверх усіх вікон" ----------
async function openPinned() {
  if (state.kiosk?.setLayout) { state.kiosk.setLayout('panel'); location.hash = '#/mini/' + cur.id; return; }
  if ('documentPictureInPicture' in window) {
    pipWin = await window.documentPictureInPicture.requestWindow({ width: 380, height: 260 });
    [...document.styleSheets].forEach(ss => { try { const st = document.createElement('style'); st.textContent = [...ss.cssRules].map(r => r.cssText).join('\n'); pipWin.document.head.append(st); } catch {} });
    pipWin.document.body.className = 'pip-body';
    pipWin.addEventListener('pagehide', () => { pipWin = null; });
    drawMini();
    return;
  }
  // Резерв: окреме мале вікно (не завжди поверх — залежить від браузера)
  window.open('#/mini/' + cur.id, 'steps', 'width=400,height=300');
  toast('Ваш браузер не підтримує «поверх усіх вікон». Використовуйте Chrome/Edge або кіоск-клієнт.', 'info', 6000);
}

function miniHtml() {
  const { total, done, curIdx } = stepsStats();
  if (curIdx === -1) return `<div class="mini"><div class="mini-top">✅ Усі кроки виконано (${done}/${total})</div>
    <button class="btn primary" data-back>🏁 Перейти до завершення</button></div>`;
  const s = cur.steps[curIdx];
  return `<div class="mini">
    <div class="mini-top"><b>Крок ${curIdx + 1} з ${total}</b><div class="progress thin"><div style="width:${done / total * 100}%"></div></div></div>
    <div class="mini-text">${md(s.text)}</div>
    <div class="mini-actions">
      <button class="btn primary" data-done="${s.id}">✓ Виконав</button>
      <button class="btn" data-help="${s.id}">❓${s.explanations ? ' ' + s.explanations : ''}</button>
      ${curIdx > 0 ? `<button class="btn ghost" data-undo="${cur.steps[curIdx - 1].id}" title="Повернутися на попередній крок">↶</button>` : ''}
      <button class="btn ghost" data-back title="Розгорнути">⤢</button>
    </div></div>`;
}
function bindMini(root, inPip) {
  $$('[data-done]', root).forEach(b => b.onclick = () => toggleStep(+b.dataset.done, true));
  $$('[data-undo]', root).forEach(b => b.onclick = () => toggleStep(+b.dataset.undo, false));
  $$('[data-help]', root).forEach(b => b.onclick = () => { if (inPip) window.focus(); helpPopup(+b.dataset.help); if (state.kiosk) state.kiosk.setLayout('work'); });
  $$('[data-back]', root).forEach(b => b.onclick = () => {
    if (inPip) { pipWin?.close(); window.focus(); }
    if (state.kiosk) state.kiosk.setLayout('work');
    location.hash = '#/lesson/' + cur.id;
  });
}
function drawMini() {
  if (!cur) return;
  if (pipWin) { pipWin.document.body.innerHTML = miniHtml(); bindMini(pipWin.document.body, true); }
  const host = $('#mini-host');
  if (host) { host.innerHTML = miniHtml(); bindMini(host, false); }
}
async function miniPage(id) {
  cur = await api('/lessons/' + id);
  document.body.classList.add('mini-mode');
  $('#app').innerHTML = '<div id="mini-host"></div>';
  drawMini();
  onLeave(() => { document.body.classList.remove('mini-mode'); });
}

// =====================================================================
// Домашнє завдання, оцінки, критерії, тренування
// =====================================================================
async function homeworkPage() {
  const d = await api('/student/home');
  shellFn(`<h1>🏠 Домашнє завдання</h1>
    ${d.homework.length ? d.homework.map(h => `
      <section class="card hw ${h.submitted ? 'done' : ''}">
        <div class="hw-head"><b>${esc(h.lesson_title || 'Завдання')}</b>
          ${h.due ? `<span class="due ${!h.submitted && h.due < new Date().toISOString().slice(0, 10) ? 'late' : ''}">до ${fmtDate(h.due)}</span>` : ''}
          ${h.submitted ? `<span class="ok-text">✓ здано ${fmtDate(h.submitted, true)}</span>` : ''}</div>
        <div>${md(h.text)}</div>
        ${h.lesson_id ? `<a href="#/lesson/${h.lesson_id}">📖 Матеріали уроку</a>` : ''}
        <form class="hw-form" data-id="${h.id}">
          <textarea name="text" rows="2" placeholder="Відповідь або коментар"></textarea>
          <input type="file" name="file">
          <button class="btn ${h.submitted ? 'ghost' : 'primary'}">${h.submitted ? 'Здати повторно' : '📨 Здати'}</button>
        </form>
      </section>`).join('') : '<p class="muted">Домашніх завдань немає 🎉</p>'}`, '#/homework');
  $$('.hw-form').forEach(f => f.onsubmit = async e => {
    e.preventDefault();
    await api(`/homework/${f.dataset.id}/submit`, { body: new FormData(f) });
    toast('Завдання здано!', 'ok'); render();
  });
}

async function gradesPage() {
  const d = await api('/student/home');
  const nums = d.grades.map(g => parseFloat(g.value)).filter(n => !isNaN(n));
  const avg = nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(1) : '—';
  shellFn(`<h1>📝 Мої оцінки</h1>
    <div class="card avg">Середній бал: <b>${avg}</b> <a href="#/criteria">Як оцінюється? →</a></div>
    ${d.grades.length ? `<table class="tbl"><thead><tr><th>Дата</th><th>Робота</th><th>Оцінка</th><th>Коментар вчителя</th></tr></thead><tbody>
      ${d.grades.map(g => `<tr><td>${fmtDate(g.created_at)}</td><td>${esc(g.kind)}${g.lesson_title ? `<br><a href="#/lesson/${g.lesson_id}">${esc(g.lesson_title)}</a>` : ''}</td>
        <td><span class="grade g${Math.min(4, Math.ceil((parseFloat(g.value) || 0) / 3))}">${esc(g.value)}</span></td><td>${esc(g.comment)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">Оцінок поки немає.</p>'}`, '#/grades');
}

async function criteriaPage() {
  const d = await api('/student/home');
  const c = d.course ? await api('/courses/' + d.course.id) : null;
  shellFn(`<h1>📏 Критерії оцінювання</h1>
    <section class="card prose">${md(c?.criteria || 'Вчитель ще не додав критерії.')}</section>
    <section class="card"><h3>Що означають позначки на моєму шляху</h3>
    <div class="legend col">${Object.values(STATES).map(s => `<span><span class="st ${s.cls}">${s.icon}</span> ${s.label}</span>`).join('')}</div></section>
    <section class="card"><h3>Ролі в парі</h3><p>⌨️ <b>Водій</b> — працює за клавіатурою і виконує кроки. 🧭 <b>Штурман</b> — читає інструкцію, перевіряє, підказує. Посеред уроку ролі міняються, тож кожен має попрацювати руками.</p></section>`, '#/criteria');
}

async function trainingPage() {
  const { questions } = await api('/training');
  let i = 0, right = 0;
  const main = shellFn(`<h1>🧠 Тренування</h1><p class="muted">Короткі запитання з уроків, які ти вже проходив. Що краще знаєш — то рідше питання повертається (інтервальне повторення).</p><div id="tq"></div>`, '#/training');
  const show = () => {
    const box = $('#tq', main);
    if (!questions.length) { box.innerHTML = '<div class="card"><p>На сьогодні все повторено! Повертайся завтра 🙂</p></div>'; return; }
    if (i >= questions.length) { box.innerHTML = `<div class="card center"><h2>Готово! ${right} / ${questions.length} ✅</h2><button class="btn primary" onclick="location.reload()">Ще раунд</button></div>`; return; }
    const q = questions[i];
    box.innerHTML = `<div class="card quiz"><small class="muted">${i + 1}/${questions.length} · ${esc(q.lesson_title)}</small><h3>${esc(q.text)}</h3>
      <div class="opts">${q.options.map((o, k) => `<button class="opt" data-k="${k}">${esc(o)}</button>`).join('')}</div><div id="fb"></div></div>`;
    $$('.opt', box).forEach(b => b.onclick = async () => {
      $$('.opt', box).forEach(x => x.disabled = true);
      const r = await api('/training/answer', { body: { question_id: q.id, choice: +b.dataset.k } });
      if (r.correct) right++;
      $$('.opt', box)[r.correct_index].classList.add('right');
      if (!r.correct) b.classList.add('wrong');
      $('#fb', box).innerHTML = `<p class="${r.correct ? 'ok-text' : 'warn-text'}">${r.correct ? 'Правильно! 🎉' : 'Не зовсім.'} ${esc(r.explain || '')}</p><button class="btn primary" id="nx">Далі →</button>`;
      $('#nx', box).onclick = () => { i++; show(); };
    });
  };
  show();
}
