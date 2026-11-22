'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');

const { all, get, run, tx, setting, setSetting, DATA_DIR } = require('./db');
const U = require('./util');
const { autoSeat } = require('./seating');

U.setSecret(setting('secret'));
const PORT = process.env.PORT || 3000;
const UPLOADS = path.join(DATA_DIR, 'uploads');

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

app.use(express.json({ limit: '20mb' }));
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (req, f, cb) => cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + path.extname(f.originalname).toLowerCase()),
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
});
// multer віддає ім'я файлу в latin1 — відновлюємо UTF-8 (кирилиця в назвах)
const origName = f => Buffer.from(f.originalname, 'latin1').toString('utf8');

// ======================================================================
// Автентифікація
// ======================================================================
function auth(req, res, next) {
  const tok = U.parseCookies(req.headers.cookie).tok || (req.headers.authorization || '').replace('Bearer ', '');
  const p = U.verifyToken(tok);
  if (!p) return res.status(401).json({ error: 'Потрібно увійти' });
  const user = get('SELECT id, role, name, login, class_id, active FROM users WHERE id=?', p.uid);
  if (!user || !user.active) return res.status(401).json({ error: 'Обліковий запис вимкнено' });
  req.user = user;
  req.pc = p.pc || null;          // номер комп'ютера в класі (якщо вхід з класу)
  req.client = p.client || 'web';
  next();
}
const teacher = (req, res, next) => (req.user.role === 'teacher' ? next() : res.status(403).json({ error: 'Лише для вчителя' }));
const h = fn => (req, res) => { try { const r = fn(req, res); if (r !== undefined) res.json(r); } catch (e) { console.error(e); res.status(400).json({ error: e.message }); } };
const bad = msg => { throw new Error(msg); };

app.post('/api/login', h((req, res) => {
  const { login, password, pc, client, host } = req.body;
  const u = get('SELECT * FROM users WHERE login=? COLLATE NOCASE', String(login || '').trim());
  if (!u || !u.active || !U.verifyPw(String(password || '').trim(), u.pw_hash)) {
    res.status(401).json({ error: 'Невірний логін або пароль' }); return;
  }
  const pcNo = pc ? parseInt(pc, 10) || null : null;
  const tok = U.signToken({ uid: u.id, pc: pcNo, client: client || 'web' }, u.role === 'teacher' ? 3600 * 24 * 14 : 3600 * 24 * 30);
  res.setHeader('Set-Cookie', `tok=${tok}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${3600 * 24 * 30}${req.secure ? '; Secure' : ''}`);
  const sess = u.role === 'student' ? activeSession(u.class_id) : null;
  const place = pcNo ? 'class' : 'home';
  run('INSERT INTO login_log(user_id,ip,computer_no,client,place,host) VALUES(?,?,?,?,?,?)', u.id, req.ip, pcNo, client || 'web', place, String(host || '').slice(0, 64) || null);
  if (u.role === 'student' && sess && pcNo) studentArrived(sess, u, pcNo);
  if (u.role === 'student') io.to('teacher').emit('login', { student_id: u.id, name: u.name, pc: pcNo, at: new Date().toISOString() });
  return { ok: true, token: tok, user: { id: u.id, role: u.role, name: u.name } };
}));
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'tok=; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/me', auth, h(req => ({ user: req.user, pc: req.pc, client: req.client, pcName: req.pc ? get('SELECT name FROM devices WHERE computer_no=?', req.pc)?.name || null : null })));
app.post('/api/me/password', auth, teacher, h(req => {
  const { old, password } = req.body;
  const u = get('SELECT pw_hash FROM users WHERE id=?', req.user.id);
  if (!U.verifyPw(old, u.pw_hash)) bad('Старий пароль невірний');
  if (!password || password.length < 6) bad('Пароль має бути не коротший за 6 символів');
  run('UPDATE users SET pw_hash=? WHERE id=?', U.hashPw(password), req.user.id);
  return { ok: true };
}));

// ======================================================================
// Допоміжні функції домену
// ======================================================================
const activeSession = classId => get("SELECT * FROM sessions WHERE class_id=? AND status='active' ORDER BY id DESC LIMIT 1", classId);
const studentsOf = classId => all("SELECT id, name, login, pw_plain, active FROM users WHERE role='student' AND class_id=? ORDER BY name", classId);
const stepsOf = lessonId => all('SELECT * FROM steps WHERE lesson_id=? ORDER BY position, id', lessonId);

function notifyTeachers(text, link) {
  for (const t of all("SELECT id FROM users WHERE role='teacher'")) run('INSERT INTO notifications(user_id,text,link) VALUES(?,?,?)', t.id, text, link || null);
  io.to('teacher').emit('notify', { text, link, at: new Date().toISOString() });
}
function notifyStudent(id, text, link) {
  run('INSERT INTO notifications(user_id,text,link) VALUES(?,?,?)', id, text, link || null);
  io.to('user:' + id).emit('notify', { text, link });
}

// Учень увійшов за комп'ютером під час уроку: відмітити присутність і місце
function studentArrived(sess, u, pcNo) {
  run(`INSERT INTO attendance(session_id,student_id,status) VALUES(?,?,'present')
       ON CONFLICT(session_id,student_id) DO UPDATE SET status=CASE WHEN status='absent' THEN 'late' ELSE status END`, sess.id, u.id);
  const seat = get('SELECT * FROM seating WHERE session_id=? AND student_id=?', sess.id, u.id);
  if (!seat || seat.computer_no !== pcNo) {
    const hasDriver = get("SELECT 1 FROM seating WHERE session_id=? AND computer_no=? AND role='driver' AND student_id<>?", sess.id, pcNo, u.id);
    const role = hasDriver ? 'navigator' : 'driver';
    run(`INSERT INTO seating(session_id,student_id,computer_no,role,was_driver) VALUES(?,?,?,?,?)
         ON CONFLICT(session_id,student_id) DO UPDATE SET computer_no=excluded.computer_no, role=excluded.role,
         was_driver=MAX(was_driver, excluded.was_driver)`, sess.id, u.id, pcNo, role, role === 'driver' ? 1 : 0);
  }
  io.to('teacher').emit('live:changed', { session_id: sess.id });
}

// Група за комп'ютером (присутні учні). Якщо розсадки немає — лише сам учень.
function groupFor(sess, student, pcNo) {
  if (!sess || !pcNo) return [{ id: student.id, role: 'driver' }];
  const g = all(`SELECT s.student_id id, s.role FROM seating s
    LEFT JOIN attendance a ON a.session_id=s.session_id AND a.student_id=s.student_id
    WHERE s.session_id=? AND s.computer_no=? AND COALESCE(a.status,'present')<>'absent'`, sess.id, pcNo);
  if (!g.find(x => x.id === student.id)) g.push({ id: student.id, role: g.length ? 'navigator' : 'driver' });
  return g;
}

// Статус уроку для набору учнів: кроки (сам/у групі), завершення, підтвердження, пропуск
function lessonStatusMap(studentIds, lessonIds, classId) {
  const res = {};
  if (!studentIds.length || !lessonIds.length) return res;
  const sIn = studentIds.join(','), lIn = lessonIds.join(',');
  const totals = Object.fromEntries(all(`SELECT lesson_id, COUNT(*) n FROM steps WHERE lesson_id IN (${lIn}) GROUP BY lesson_id`).map(r => [r.lesson_id, r.n]));
  for (const s of studentIds) { res[s] = {}; for (const l of lessonIds) res[s][l] = { total: totals[l] || 0, self: 0, group: 0, home: 0 }; }
  for (const r of all(`SELECT p.student_id, st.lesson_id, SUM(p.via='self') self, SUM(p.via='group') grp, SUM(p.place='home') home
      FROM progress p JOIN steps st ON st.id=p.step_id WHERE p.student_id IN (${sIn}) AND st.lesson_id IN (${lIn})
      GROUP BY p.student_id, st.lesson_id`)) Object.assign(res[r.student_id][r.lesson_id], { self: r.self, group: r.grp, home: r.home });
  for (const r of all(`SELECT * FROM lesson_status WHERE student_id IN (${sIn}) AND lesson_id IN (${lIn})`)) {
    Object.assign(res[r.student_id][r.lesson_id], { finished_at: r.finished_at, mastery: r.mastery, screenshot: r.screenshot, self_assess: r.self_assess ? JSON.parse(r.self_assess) : null, reflection: r.reflection });
  }
  if (classId) {
    // уроки, що проводилися/зірвалися для класу, та відвідування
    for (const r of all(`SELECT x.lesson_id, x.status, x.date, a.student_id, a.status att FROM sessions x
        LEFT JOIN attendance a ON a.session_id=x.id WHERE x.class_id=? AND x.lesson_id IN (${lIn})`, classId)) {
      for (const s of studentIds) {
        const c = res[s][r.lesson_id];
        if (r.status === 'cancelled') c.cancelled = r.date;
        if (r.student_id === s) { c.att = c.att === 'present' ? c.att : r.att; c.date = r.date; }
        c.held = c.held || r.status === 'done';
      }
    }
  }
  for (const s of studentIds) for (const l of lessonIds) {
    const c = res[s][l];
    const done = c.self + c.group;
    c.state =
      c.mastery === 1 ? 'mastered' :
      c.mastery === 0 ? 'struggling' :
      c.total && c.self >= c.total ? 'done_self' :
      c.total && done >= c.total ? 'done_group' :
      done > 0 ? 'partial' :
      c.finished_at ? 'done_self' :
      c.held && ['present', 'late'].includes(c.att) ? 'idle' :
      (c.held && c.att === 'absent') || (c.held && !c.att) ? 'missed' :
      c.cancelled ? 'cancelled' : 'none';
  }
  return res;
}

function courseTree(courseId) {
  const course = get('SELECT * FROM courses WHERE id=?', courseId);
  if (!course) return null;
  course.units = all('SELECT * FROM units WHERE course_id=? ORDER BY position, id', courseId);
  for (const u of course.units) {
    u.lessons = all(`SELECT l.id, l.title, l.position, l.objectives, (SELECT COUNT(*) FROM steps s WHERE s.lesson_id=l.id) steps
      FROM lessons l WHERE unit_id=? ORDER BY position, id`, u.id);
  }
  return course;
}
const lessonIdsOfCourse = courseId => all(`SELECT l.id FROM lessons l JOIN units u ON u.id=l.unit_id WHERE u.course_id=? ORDER BY u.position, u.id, l.position, l.id`, courseId).map(r => r.id);

function canSeeLesson(user, lessonId) {
  if (user.role === 'teacher') return true;
  return !!get(`SELECT 1 FROM lessons l JOIN units u ON u.id=l.unit_id JOIN classes c ON c.course_id=u.course_id WHERE l.id=? AND c.id=?`, lessonId, user.class_id);
}

function saveDataUrl(dataUrl, sub = 'screens') {
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const name = `${sub}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(UPLOADS, name), Buffer.from(m[2], 'base64'));
  return '/uploads/' + name;
}

function parseQuestions(text) {
  // Формат:  ? Питання   + правильна   - неправильна   ! пояснення
  const out = []; let q = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim(); if (!line) continue;
    if (line.startsWith('?')) { q = { text: line.slice(1).trim(), options: [], correct: 0, explain: '' }; out.push(q); }
    else if (q && (line.startsWith('+') || line.startsWith('-'))) { if (line[0] === '+') q.correct = q.options.length; q.options.push(line.slice(1).trim()); }
    else if (q && line.startsWith('!')) q.explain = line.slice(1).trim();
  }
  return out.filter(x => x.text && x.options.length >= 2);
}
function questionsToText(qs) {
  return qs.map(q => [`? ${q.text}`, ...JSON.parse(q.options).map((o, i) => `${i === q.correct ? '+' : '-'} ${o}`), q.explain ? `! ${q.explain}` : null].filter(Boolean).join('\n')).join('\n\n');
}

// ======================================================================
// Класи та учні
// ======================================================================
app.get('/api/classes', auth, teacher, h(() => all(`SELECT c.*, co.title course_title,
  (SELECT COUNT(*) FROM users u WHERE u.class_id=c.id AND u.role='student') students,
  (SELECT id FROM sessions s WHERE s.class_id=c.id AND s.status='active' LIMIT 1) active_session
  FROM classes c LEFT JOIN courses co ON co.id=c.course_id ORDER BY c.name`)));
app.post('/api/classes', auth, teacher, h(req => ({ id: run('INSERT INTO classes(name,course_id) VALUES(?,?)', req.body.name, req.body.course_id || null).lastInsertRowid })));
app.put('/api/classes/:id', auth, teacher, h(req => { run('UPDATE classes SET name=?, course_id=? WHERE id=?', req.body.name, req.body.course_id || null, req.params.id); return { ok: true }; }));
app.delete('/api/classes/:id', auth, teacher, h(req => { run('DELETE FROM classes WHERE id=?', req.params.id); return { ok: true }; }));

app.get('/api/classes/:id/students', auth, teacher, h(req => {
  const st = studentsOf(req.params.id);
  const last = Object.fromEntries(all(`SELECT user_id, MAX(at) at FROM login_log GROUP BY user_id`).map(r => [r.user_id, r.at]));
  st.forEach(s => { s.last_login = last[s.id] || null; s.online = online.has(s.id); });
  return st;
}));
app.post('/api/classes/:id/students', auth, teacher, h(req => {
  const names = String(req.body.names || '').split('\n').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  return tx(() => names.map(name => {
    const pw = U.genPassword();
    const base = U.translit(name.split(' ')[0]) || 'student';
    let login = base, i = 1;
    while (get('SELECT 1 FROM users WHERE login=?', login)) login = base + (++i);
    const id = run("INSERT INTO users(role,name,login,pw_hash,pw_plain,class_id) VALUES('student',?,?,?,?,?)", name, login, U.hashPw(pw), pw, req.params.id).lastInsertRowid;
    return { id, name, login, password: pw };
  }));
}));
app.put('/api/students/:id', auth, teacher, h(req => {
  const { name, login, class_id, active } = req.body;
  if (login && get('SELECT 1 FROM users WHERE login=? AND id<>?', login, req.params.id)) bad('Такий логін уже існує');
  run("UPDATE users SET name=COALESCE(?,name), login=COALESCE(?,login), class_id=COALESCE(?,class_id), active=COALESCE(?,active) WHERE id=? AND role='student'",
    name ?? null, login ?? null, class_id ?? null, active ?? null, req.params.id);
  return { ok: true };
}));
app.post('/api/students/:id/reset', auth, teacher, h(req => {
  const pw = U.genPassword();
  run("UPDATE users SET pw_hash=?, pw_plain=? WHERE id=? AND role='student'", U.hashPw(pw), pw, req.params.id);
  return { password: pw };
}));
app.delete('/api/students/:id', auth, teacher, h(req => { run("DELETE FROM users WHERE id=? AND role='student'", req.params.id); return { ok: true }; }));

app.get('/api/logins', auth, teacher, h(req => all(`SELECT l.*, u.name, c.name class_name FROM login_log l JOIN users u ON u.id=l.user_id
  LEFT JOIN classes c ON c.id=u.class_id WHERE u.role='student' ${req.query.class_id ? 'AND u.class_id=' + parseInt(req.query.class_id, 10) : ''}
  ${req.query.student_id ? 'AND u.id=' + parseInt(req.query.student_id, 10) : ''} ORDER BY l.id DESC LIMIT 300`)));

// ======================================================================
// Курси, розділи, уроки, кроки, матеріали
// ======================================================================
app.get('/api/courses', auth, teacher, h(() => all('SELECT id, title FROM courses ORDER BY title')));
app.get('/api/courses/:id', auth, h(req => {
  if (req.user.role !== 'teacher' && !get('SELECT 1 FROM classes WHERE id=? AND course_id=?', req.user.class_id, req.params.id)) bad('Немає доступу');
  return courseTree(req.params.id);
}));
app.post('/api/courses', auth, teacher, h(req => ({ id: run('INSERT INTO courses(title,description,criteria) VALUES(?,?,?)', req.body.title, req.body.description || '', req.body.criteria || '').lastInsertRowid })));
app.put('/api/courses/:id', auth, teacher, h(req => { run('UPDATE courses SET title=?, description=?, criteria=? WHERE id=?', req.body.title, req.body.description || '', req.body.criteria || '', req.params.id); return { ok: true }; }));
app.delete('/api/courses/:id', auth, teacher, h(req => { run('DELETE FROM courses WHERE id=?', req.params.id); return { ok: true }; }));

app.post('/api/units', auth, teacher, h(req => {
  const pos = (get('SELECT MAX(position) m FROM units WHERE course_id=?', req.body.course_id).m || 0) + 1;
  return { id: run('INSERT INTO units(course_id,position,title,goal,why) VALUES(?,?,?,?,?)', req.body.course_id, pos, req.body.title, req.body.goal || '', req.body.why || '').lastInsertRowid };
}));
app.put('/api/units/:id', auth, teacher, h(req => {
  const b = req.body;
  run('UPDATE units SET title=COALESCE(?,title), goal=COALESCE(?,goal), why=COALESCE(?,why), position=COALESCE(?,position) WHERE id=?', b.title ?? null, b.goal ?? null, b.why ?? null, b.position ?? null, req.params.id);
  return { ok: true };
}));
app.delete('/api/units/:id', auth, teacher, h(req => { run('DELETE FROM units WHERE id=?', req.params.id); return { ok: true }; }));

app.post('/api/lessons', auth, teacher, h(req => {
  const pos = (get('SELECT MAX(position) m FROM lessons WHERE unit_id=?', req.body.unit_id).m || 0) + 1;
  return { id: run('INSERT INTO lessons(unit_id,position,title) VALUES(?,?,?)', req.body.unit_id, pos, req.body.title || 'Новий урок').lastInsertRowid };
}));
app.get('/api/lessons/:id', auth, h(req => {
  const id = +req.params.id;
  if (!canSeeLesson(req.user, id)) bad('Немає доступу');
  const l = get('SELECT l.*, u.title unit_title, u.course_id, u.goal unit_goal, u.why unit_why FROM lessons l JOIN units u ON u.id=l.unit_id WHERE l.id=?', id);
  if (!l) bad('Урок не знайдено');
  l.steps = stepsOf(id);
  const ex = Object.fromEntries(all(`SELECT step_id, COUNT(*) n FROM explanations WHERE step_id IN (SELECT id FROM steps WHERE lesson_id=?) GROUP BY step_id`, id).map(r => [r.step_id, r.n]));
  l.steps.forEach(s => { s.explanations = ex[s.id] || 0; });
  l.materials = all('SELECT * FROM materials WHERE lesson_id=? ORDER BY id', id);
  if (req.user.role === 'teacher') {
    l.questions_text = questionsToText(all('SELECT * FROM questions WHERE lesson_id=?', id));
  } else {
    const me = req.user.id;
    const prog = Object.fromEntries(all('SELECT * FROM progress WHERE student_id=? AND step_id IN (SELECT id FROM steps WHERE lesson_id=?)', me, id).map(p => [p.step_id, p]));
    l.steps.forEach(s => { s.done = prog[s.id] || null; });
    l.my = get('SELECT finished_at, self_assess, reflection, mastery FROM lesson_status WHERE student_id=? AND lesson_id=?', me, id) || {};
    l.homework_list = all('SELECT h.*, (SELECT id FROM submissions s WHERE s.homework_id=h.id AND s.student_id=?) submitted FROM homework h WHERE class_id=? AND lesson_id=?', me, req.user.class_id, id);
    const sess = activeSession(req.user.class_id);
    if (sess && sess.lesson_id === id && req.pc) {
      l.session = { id: sess.id, mode: sess.mode, pc: req.pc };
      l.group = all(`SELECT u.id, u.name, s.role FROM seating s JOIN users u ON u.id=s.student_id WHERE s.session_id=? AND s.computer_no=?`, sess.id, req.pc);
    }
    l.place = sess && sess.lesson_id === id && req.pc ? 'class' : 'home';
  }
  return l;
}));
app.put('/api/lessons/:id', auth, teacher, h(req => {
  const b = req.body, id = +req.params.id;
  tx(() => {
    run(`UPDATE lessons SET title=?, objectives=?, why=?, success_criteria=?, theory=?, homework=?, unit_id=COALESCE(?,unit_id), position=COALESCE(?,position) WHERE id=?`,
      b.title, b.objectives || '', b.why || '', b.success_criteria || '', b.theory || '', b.homework || '', b.unit_id ?? null, b.position ?? null, id);
    if (Array.isArray(b.steps)) {
      // зберігаємо id наявних кроків, щоб не втратити прогрес і пояснення
      const keep = new Set();
      b.steps.forEach((s, i) => {
        if (!String(s.text || '').trim()) return;
        if (s.id && get('SELECT 1 FROM steps WHERE id=? AND lesson_id=?', s.id, id)) { run('UPDATE steps SET text=?, position=? WHERE id=?', s.text, i + 1, s.id); keep.add(+s.id); }
        else keep.add(Number(run('INSERT INTO steps(lesson_id,position,text) VALUES(?,?,?)', id, i + 1, s.text).lastInsertRowid));
      });
      for (const s of stepsOf(id)) if (!keep.has(s.id)) run('DELETE FROM steps WHERE id=?', s.id);
    }
    if (typeof b.questions_text === 'string') {
      const qs = parseQuestions(b.questions_text);
      const old = all('SELECT * FROM questions WHERE lesson_id=? ORDER BY id', id);
      qs.forEach((q, i) => {
        if (old[i]) run('UPDATE questions SET text=?, options=?, correct=?, explain=? WHERE id=?', q.text, JSON.stringify(q.options), q.correct, q.explain, old[i].id);
        else run('INSERT INTO questions(lesson_id,text,options,correct,explain) VALUES(?,?,?,?,?)', id, q.text, JSON.stringify(q.options), q.correct, q.explain);
      });
      old.slice(qs.length).forEach(o => run('DELETE FROM questions WHERE id=?', o.id));
    }
  });
  return { ok: true };
}));
app.delete('/api/lessons/:id', auth, teacher, h(req => { run('DELETE FROM lessons WHERE id=?', req.params.id); return { ok: true }; }));

// Імпорт інструкційної картки з DOCX: кожен пункт списку / абзац = крок
app.post('/api/lessons/:id/import', auth, teacher, upload.single('file'), async (req, res) => {
  try {
    const mammoth = require('mammoth');
    const f = req.file; if (!f) throw new Error('Файл не отримано');
    let steps = [];
    if (/\.docx$/i.test(origName(f))) {
      const { value: html } = await mammoth.convertToHtml({ path: f.path });
      const items = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(m => m[1]);
      const src = items.length >= 2 ? items : [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m => m[1]);
      steps = src.map(x => x.replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**').replace(/<em>([\s\S]*?)<\/em>/g, '*$1*')
        .replace(/<img[^>]*>/g, '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim()).filter(Boolean);
    } else {
      steps = fs.readFileSync(f.path, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
    }
    steps = steps.map(s => s.replace(/^(\d+[.)]|[-•*])\s*/, ''));
    // зберігаємо оригінал як матеріал "інструкційна картка"
    run('INSERT INTO materials(lesson_id,kind,title,filename,url,mime) VALUES(?,?,?,?,?,?)', req.params.id, 'card', origName(f), f.filename, '/uploads/' + f.filename, f.mimetype);
    res.json({ steps });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/lessons/:id/materials', auth, teacher, upload.single('file'), h(req => {
  const b = req.body, f = req.file;
  if (f) {
    const name = origName(f);
    const kind = b.kind || (/pdf$/i.test(name) ? 'presentation' : f.mimetype.startsWith('video') ? 'video' : f.mimetype.startsWith('image') ? 'image' : 'file');
    return { id: run('INSERT INTO materials(lesson_id,kind,title,filename,url,mime) VALUES(?,?,?,?,?,?)', req.params.id, kind, b.title || name, f.filename, '/uploads/' + f.filename, f.mimetype).lastInsertRowid };
  }
  if (!b.url) bad('Додайте файл або посилання');
  return { id: run('INSERT INTO materials(lesson_id,kind,title,url) VALUES(?,?,?,?)', req.params.id, b.kind || 'link', b.title || b.url, b.url).lastInsertRowid };
}));
app.delete('/api/materials/:id', auth, teacher, h(req => { run('DELETE FROM materials WHERE id=?', req.params.id); return { ok: true }; }));
app.post('/api/upload-image', auth, teacher, upload.single('file'), h(req => ({ url: '/uploads/' + req.file.filename })));

// ======================================================================
// Заняття (урок у класі): старт, режими, відвідування, розсадка
// ======================================================================
app.get('/api/sessions', auth, teacher, h(req => all(`SELECT s.*, l.title lesson_title, c.name class_name,
  (SELECT COUNT(*) FROM attendance a WHERE a.session_id=s.id AND a.status<>'absent') present
  FROM sessions s LEFT JOIN lessons l ON l.id=s.lesson_id JOIN classes c ON c.id=s.class_id
  ${req.query.class_id ? 'WHERE s.class_id=' + parseInt(req.query.class_id, 10) : ''} ORDER BY s.date DESC, s.id DESC LIMIT 200`)));

app.post('/api/sessions', auth, teacher, h(req => {
  const { class_id, lesson_id } = req.body;
  const computers = parseInt(req.body.computers, 10);
  if (!(computers >= 1 && computers <= 60)) bad("Вкажіть, скільки комп'ютерів працює на цьому уроці (1–60)");
  setSetting('computers', computers); // запам'ятовуємо як підказку для наступного разу
  // Комп'ютерний клас один — завершуємо інші активні заняття
  for (const s of all("SELECT id FROM sessions WHERE status='active'")) endSession(s.id);
  const id = run("INSERT INTO sessions(class_id,lesson_id,date,status,mode,computers) VALUES(?,?,?,'active','work',?)", class_id, lesson_id, U.today(), computers).lastInsertRowid;
  const lesson = get('SELECT title FROM lessons WHERE id=?', lesson_id);
  io.to('class:' + class_id).emit('session', { id, lesson_id, mode: 'work', title: lesson?.title });
  io.to('devices').emit('lab:mode', { mode: 'work', session_id: id });
  return { id };
}));
function endSession(id) {
  const s = get('SELECT * FROM sessions WHERE id=?', id); if (!s) return;
  if (s.status === 'active') run("UPDATE sessions SET status='done', mode='work', ended_at=CURRENT_TIMESTAMP WHERE id=?", id);
  // хто не відмічений — відсутній
  for (const st of studentsOf(s.class_id)) run("INSERT OR IGNORE INTO attendance(session_id,student_id,status) VALUES(?,?,'absent')", id, st.id);
  io.to('class:' + s.class_id).emit('session', null);
  io.to('devices').emit('lab:mode', { mode: 'none' });
  closeKiosksAfterLesson();
}
// Кіоск запускається вручну (через Veyon) — після уроку закриваємо його на всіх ПК, щоб звільнити їх для інших вчителів
function closeKiosksAfterLesson() {
  if (!setting('close_kiosk_on_end', true)) return;
  for (const id of deviceSockets.keys()) expectedExit.add(id);
  io.to('devices').emit('device:exit');
}
app.post('/api/sessions/:id/end', auth, teacher, h(req => { endSession(+req.params.id); return { ok: true }; }));
// Урок зірвано/не відбувся (повітряна тривога тощо) — фіксуємо, прогрес не втрачається
app.post('/api/sessions/:id/cancel', auth, teacher, h(req => {
  const s = get('SELECT * FROM sessions WHERE id=?', req.params.id);
  run("UPDATE sessions SET status='cancelled', cancel_reason=?, mode='work', ended_at=CURRENT_TIMESTAMP WHERE id=?", req.body.reason || 'Повітряна тривога', s.id);
  io.to('class:' + s.class_id).emit('session', null);
  io.to('devices').emit('lab:mode', { mode: 'none' });
  closeKiosksAfterLesson();
  for (const st of studentsOf(s.class_id)) notifyStudent(st.id, `Урок «${get('SELECT title FROM lessons WHERE id=?', s.lesson_id)?.title}» не завершено (${req.body.reason || 'тривога'}). Можна виконати вдома — прогрес збережено.`, `#/lesson/${s.lesson_id}`);
  return { ok: true };
}));
app.post('/api/sessions/missed', auth, teacher, h(req => {
  const { class_id, lesson_id, date, reason } = req.body;
  return { id: run("INSERT INTO sessions(class_id,lesson_id,date,status,cancel_reason) VALUES(?,?,?,'cancelled',?)", class_id, lesson_id, date || U.today(), reason || 'Повітряна тривога').lastInsertRowid };
}));
app.delete('/api/sessions/:id', auth, teacher, h(req => { run('DELETE FROM sessions WHERE id=?', req.params.id); return { ok: true }; }));

app.get('/api/sessions/:id/live', auth, teacher, h(req => {
  const s = get('SELECT s.*, c.name class_name FROM sessions s JOIN classes c ON c.id=s.class_id WHERE s.id=?', req.params.id);
  if (!s) bad('Заняття не знайдено');
  s.demo = JSON.parse(s.demo || '{}');
  const lesson = s.lesson_id ? get('SELECT id, title, success_criteria FROM lessons WHERE id=?', s.lesson_id) : null;
  if (lesson) { lesson.steps = stepsOf(lesson.id); lesson.materials = all("SELECT * FROM materials WHERE lesson_id=?", lesson.id); }
  const students = studentsOf(s.class_id).map(st => ({ id: st.id, name: st.name }));
  const att = Object.fromEntries(all('SELECT student_id, status FROM attendance WHERE session_id=?', s.id).map(r => [r.student_id, r.status]));
  const seats = Object.fromEntries(all('SELECT * FROM seating WHERE session_id=?', s.id).map(r => [r.student_id, r]));
  const stepIds = lesson ? lesson.steps.map(x => x.id) : [];
  const prog = {};
  if (stepIds.length) for (const p of all(`SELECT student_id, step_id, via FROM progress WHERE step_id IN (${stepIds.join(',')})`)) (prog[p.student_id] ||= []).push(p);
  const fin = Object.fromEntries(lesson ? all('SELECT student_id, finished_at, screenshot, mastery FROM lesson_status WHERE lesson_id=?', lesson.id).map(r => [r.student_id, r]) : []);
  for (const st of students) {
    st.att = att[st.id] || null; st.seat = seats[st.id] || null;
    st.online = online.has(st.id) ? [...online.get(st.id).values()].map(v => v.pc).filter(Boolean) : null;
    st.steps = (prog[st.id] || []).map(p => ({ step_id: p.step_id, via: p.via }));
    st.finished = fin[st.id] || null;
    st.focusLost = focusAlerts.get(st.id) || null;
  }
  const help = all(`SELECT h.*, u.name, st.text step_text, st.position step_pos FROM help_requests h JOIN users u ON u.id=h.student_id
    JOIN steps st ON st.id=h.step_id WHERE h.session_id=? ORDER BY h.status='open' DESC, h.id DESC`, s.id);
  for (const r of help) r.existing = explanationsFor(r.step_id, null);
  const finishes = all(`SELECT sb.*, u.name FROM submissions sb JOIN users u ON u.id=sb.student_id WHERE sb.session_id=? AND sb.kind='finish' ORDER BY sb.id DESC`, s.id);
  const kiosks = Object.fromEntries(all('SELECT id, computer_no, locked, name FROM devices').map(d => [d.computer_no, { online: deviceSockets.has(d.id), locked: !!d.locked, name: d.name }]));
  return { session: s, lesson, students, help, finishes, kiosks, closeKiosk: setting('close_kiosk_on_end', true), computers: s.computers || setting('computers', 10) };
}));

// Змінити кількість комп'ютерів посеред уроку (зламався ПК тощо)
app.put('/api/sessions/:id/computers', auth, teacher, h(req => {
  const n = parseInt(req.body.computers, 10);
  if (!(n >= 1 && n <= 60)) bad('Кількість має бути від 1 до 60');
  run('UPDATE sessions SET computers=? WHERE id=?', n, req.params.id);
  setSetting('computers', n);
  // учні, що сиділи за ПК з номером більше n, стають «не розсадженими»
  const moved = run('DELETE FROM seating WHERE session_id=? AND computer_no>?', req.params.id, n).changes;
  pushSeating(get('SELECT * FROM sessions WHERE id=?', req.params.id));
  return { ok: true, unseated: moved };
}));
app.put('/api/sessions/:id/attendance', auth, teacher, h(req => {
  const { student_id, status } = req.body;
  if (status) run('INSERT INTO attendance(session_id,student_id,status) VALUES(?,?,?) ON CONFLICT(session_id,student_id) DO UPDATE SET status=excluded.status', req.params.id, student_id, status);
  else run('DELETE FROM attendance WHERE session_id=? AND student_id=?', req.params.id, student_id);
  if (status === 'absent') run('DELETE FROM seating WHERE session_id=? AND student_id=?', req.params.id, student_id);
  return { ok: true };
}));
app.post('/api/sessions/:id/attendance/all', auth, teacher, h(req => {
  const s = get('SELECT * FROM sessions WHERE id=?', req.params.id);
  for (const st of studentsOf(s.class_id)) run("INSERT OR IGNORE INTO attendance(session_id,student_id,status) VALUES(?,?,?)", s.id, st.id, req.body.status || 'present');
  return { ok: true };
}));

app.post('/api/sessions/:id/seating/auto', auth, teacher, h(req => {
  const s = get('SELECT * FROM sessions WHERE id=?', req.params.id);
  let ids = all("SELECT student_id FROM attendance WHERE session_id=? AND status<>'absent'", s.id).map(r => r.student_id);
  if (!ids.length) ids = studentsOf(s.class_id).map(x => x.id);
  const plan = autoSeat(s.id, ids, s.computers || setting('computers', 10));
  tx(() => {
    run('DELETE FROM seating WHERE session_id=?', s.id);
    for (const p of plan) run('INSERT INTO seating(session_id,student_id,computer_no,role,was_driver) VALUES(?,?,?,?,?)', s.id, p.student_id, p.computer_no, p.role, p.role === 'driver' ? 1 : 0);
  });
  pushSeating(s);
  return plan;
}));
app.put('/api/sessions/:id/seating', auth, teacher, h(req => {
  const s = get('SELECT * FROM sessions WHERE id=?', req.params.id);
  const { student_id, computer_no, role } = req.body;
  if (!computer_no) run('DELETE FROM seating WHERE session_id=? AND student_id=?', s.id, student_id);
  else run(`INSERT INTO seating(session_id,student_id,computer_no,role,was_driver) VALUES(?,?,?,?,?)
    ON CONFLICT(session_id,student_id) DO UPDATE SET computer_no=excluded.computer_no, role=excluded.role, was_driver=MAX(was_driver,excluded.was_driver)`,
  s.id, student_id, computer_no, role || 'navigator', role === 'driver' ? 1 : 0);
  if (role === 'driver') run("UPDATE seating SET role='navigator' WHERE session_id=? AND computer_no=? AND student_id<>?", s.id, computer_no, student_id);
  pushSeating(s);
  return { ok: true };
}));
// Поміняти ролі водій ↔ штурман за кожним комп'ютером
app.post('/api/sessions/:id/seating/rotate', auth, teacher, h(req => {
  const s = get('SELECT * FROM sessions WHERE id=?', req.params.id);
  const byPc = {};
  for (const r of all('SELECT * FROM seating WHERE session_id=? ORDER BY student_id', s.id)) (byPc[r.computer_no] ||= []).push(r);
  tx(() => {
    for (const list of Object.values(byPc)) {
      if (list.length < 2) continue;
      const di = Math.max(0, list.findIndex(r => r.role === 'driver'));
      // наступним водієм стає той, хто найменше був за клавіатурою
      const cand = list.filter((r, i) => i !== di).sort((a, b) => a.was_driver - b.was_driver)[0];
      for (const r of list) run('UPDATE seating SET role=?, was_driver=MAX(was_driver,?) WHERE session_id=? AND student_id=?', r === cand ? 'driver' : 'navigator', r === cand ? 1 : 0, s.id, r.student_id);
    }
  });
  pushSeating(s);
  return { ok: true };
}));
function pushSeating(s) {
  for (const r of all('SELECT s.student_id, s.computer_no, s.role FROM seating s WHERE s.session_id=?', s.id)) io.to('user:' + r.student_id).emit('seat', r);
  io.to('class:' + s.class_id).emit('group:changed');
}

app.post('/api/sessions/:id/mode', auth, teacher, h(req => {
  const s = get('SELECT * FROM sessions WHERE id=?', req.params.id);
  const mode = req.body.mode || 'work';
  const demo = req.body.demo || {};
  run('UPDATE sessions SET mode=?, demo=? WHERE id=?', mode, JSON.stringify(demo), s.id);
  if (mode === 'work') focusAlerts.clear();
  io.to('class:' + s.class_id).emit('mode', { session_id: s.id, mode, demo });
  io.to('devices').emit('lab:mode', { mode, session_id: s.id });
  return { ok: true };
}));
app.get('/api/sessions/:id/demo', auth, h(req => {
  const s = get('SELECT id, class_id, mode, demo FROM sessions WHERE id=?', req.params.id);
  if (!s || (req.user.role !== 'teacher' && s.class_id !== req.user.class_id)) bad('Немає доступу');
  const demo = JSON.parse(s.demo || '{}');
  if (demo.material_id) demo.material = get('SELECT id, kind, title, url, mime FROM materials WHERE id=?', demo.material_id);
  return { mode: s.mode, demo };
}));

// ======================================================================
// Робота учня: кроки, пояснення, завершення
// ======================================================================
app.post('/api/progress', auth, h(req => {
  if (req.user.role !== 'student') bad('Лише для учнів');
  const { step_id, done } = req.body;
  const step = get('SELECT * FROM steps WHERE id=?', step_id);
  if (!step || !canSeeLesson(req.user, step.lesson_id)) bad('Крок не знайдено');
  const sess = activeSession(req.user.class_id);
  const inClass = sess && sess.lesson_id === step.lesson_id && req.pc;
  const group = groupFor(inClass ? sess : null, req.user, req.pc);
  for (const m of group) {
    if (done) {
      const via = group.length === 1 || m.role === 'driver' ? 'self' : 'group';
      run(`INSERT INTO progress(student_id,step_id,session_id,computer_no,via,place,clicked_by) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(student_id,step_id) DO UPDATE SET via=CASE WHEN progress.via='group' AND excluded.via='self' THEN 'self' ELSE progress.via END`,
      m.id, step.id, inClass ? sess.id : null, inClass ? req.pc : null, via, inClass ? 'class' : 'home', req.user.id);
    } else {
      run('DELETE FROM progress WHERE student_id=? AND step_id=?', m.id, step.id);
    }
    if (m.id !== req.user.id) io.to('user:' + m.id).emit('progress', { step_id: step.id, done: !!done });
  }
  io.to('teacher').emit('progress', { session_id: inClass ? sess.id : null, student_ids: group.map(g => g.id), step_id: step.id, done: !!done, pc: req.pc });
  if (!inClass && done) {
    const total = get('SELECT COUNT(*) n FROM steps WHERE lesson_id=?', step.lesson_id).n;
    const mine = get('SELECT COUNT(*) n FROM progress p JOIN steps s ON s.id=p.step_id WHERE p.student_id=? AND s.lesson_id=?', req.user.id, step.lesson_id).n;
    if (total && mine === total) notifyTeachers(`🏠 ${req.user.name} виконав(ла) вдома всі кроки уроку «${get('SELECT title FROM lessons WHERE id=?', step.lesson_id).title}»`, `#/student/${req.user.id}`);
  }
  return { ok: true, group: group.length };
}));

function explanationsFor(stepId, me) {
  return all(`SELECT e.id, e.text, e.created_at, COALESCE(AVG(s.value),0) avg, COUNT(s.value) votes
    ${me ? ', (SELECT value FROM stars WHERE explanation_id=e.id AND student_id=' + Number(me) + ') mine' : ''}
    FROM explanations e LEFT JOIN stars s ON s.explanation_id=e.id WHERE e.step_id=? GROUP BY e.id ORDER BY avg DESC, votes DESC, e.id DESC`, stepId);
}
app.get('/api/steps/:id/explanations', auth, h(req => {
  const step = get('SELECT * FROM steps WHERE id=?', req.params.id);
  if (!step || !canSeeLesson(req.user, step.lesson_id)) bad('Немає доступу');
  return { step, explanations: explanationsFor(step.id, req.user.role === 'student' ? req.user.id : null),
    my_requests: req.user.role === 'student' ? all('SELECT * FROM help_requests WHERE student_id=? AND step_id=? ORDER BY id DESC', req.user.id, step.id) : [] };
}));
app.post('/api/explanations/:id/star', auth, h(req => {
  const v = Math.max(1, Math.min(5, parseInt(req.body.value, 10) || 0));
  run('INSERT INTO stars(explanation_id,student_id,value) VALUES(?,?,?) ON CONFLICT(explanation_id,student_id) DO UPDATE SET value=excluded.value', req.params.id, req.user.id, v);
  return { ok: true };
}));
app.post('/api/help', auth, h(req => {
  const { step_id, question } = req.body;
  const step = get('SELECT * FROM steps WHERE id=?', step_id);
  if (!step || !canSeeLesson(req.user, step.lesson_id)) bad('Крок не знайдено');
  if (get("SELECT 1 FROM help_requests WHERE student_id=? AND step_id=? AND status='open'", req.user.id, step_id)) bad('Ти вже попросив пояснення до цього кроку — чекай відповіді');
  const sess = activeSession(req.user.class_id);
  const inClass = sess && sess.lesson_id === step.lesson_id;
  const id = run('INSERT INTO help_requests(student_id,step_id,session_id,computer_no,question) VALUES(?,?,?,?,?)', req.user.id, step_id, inClass ? sess.id : null, req.pc, question || '').lastInsertRowid;
  const msg = `🙋 ${req.user.name}${req.pc ? ' (ПК ' + req.pc + ')' : ''}: пояснення до кроку ${step.position}${question ? ' — «' + question + '»' : ''}`;
  io.to('teacher').emit('help:new', { id, session_id: inClass ? sess.id : null });
  notifyTeachers(msg, inClass ? `#/live/${sess.id}` : '#/help');
  return { id };
}));
app.get('/api/help', auth, teacher, h(req => {
  const rows = all(`SELECT h.*, u.name, st.text step_text, st.position step_pos, l.title lesson_title FROM help_requests h
    JOIN users u ON u.id=h.student_id JOIN steps st ON st.id=h.step_id JOIN lessons l ON l.id=st.lesson_id
    ${req.query.all ? '' : "WHERE h.status='open'"} ORDER BY h.id DESC LIMIT 200`);
  for (const r of rows) r.existing = explanationsFor(r.step_id, null);
  return rows;
}));
app.post('/api/help/:id/answer', auth, teacher, h(req => {
  const r = get('SELECT * FROM help_requests WHERE id=?', req.params.id);
  if (!r) bad('Запит не знайдено');
  let exId = req.body.explanation_id;
  if (!exId) {
    if (!String(req.body.text || '').trim()) bad('Напишіть пояснення');
    exId = run('INSERT INTO explanations(step_id,text) VALUES(?,?)', r.step_id, req.body.text.trim()).lastInsertRowid;
  }
  run("UPDATE help_requests SET status='answered', explanation_id=?, answered_at=CURRENT_TIMESTAMP WHERE id=?", exId, r.id);
  // те саме пояснення закриває й інші відкриті запити до цього кроку
  const others = all("SELECT * FROM help_requests WHERE step_id=? AND status='open'", r.step_id);
  for (const o of others) run("UPDATE help_requests SET status='answered', explanation_id=?, answered_at=CURRENT_TIMESTAMP WHERE id=?", exId, o.id);
  const ex = get('SELECT * FROM explanations WHERE id=?', exId);
  for (const sid of [r.student_id, ...others.map(o => o.student_id)]) io.to('user:' + sid).emit('help:answered', { step_id: r.step_id, explanation: ex });
  const st = get('SELECT lesson_id FROM steps WHERE id=?', r.step_id);
  io.emit('explanation:new', { step_id: r.step_id, lesson_id: st.lesson_id });
  return { ok: true, explanation_id: exId, closed: 1 + others.length };
}));
app.post('/api/explanations', auth, teacher, h(req => ({ id: run('INSERT INTO explanations(step_id,text) VALUES(?,?)', req.body.step_id, req.body.text).lastInsertRowid })));
app.put('/api/explanations/:id', auth, teacher, h(req => { run('UPDATE explanations SET text=? WHERE id=?', req.body.text, req.params.id); return { ok: true }; }));
app.delete('/api/explanations/:id', auth, teacher, h(req => { run('DELETE FROM explanations WHERE id=?', req.params.id); return { ok: true }; }));

// "Я закінчив": скриншот + самооцінювання + рефлексія, сповіщення вчителю
app.post('/api/finish', auth, h(req => {
  if (req.user.role !== 'student') bad('Лише для учнів');
  const { lesson_id, screenshot, self_assess, reflection } = req.body;
  if (!canSeeLesson(req.user, lesson_id)) bad('Немає доступу');
  const shot = saveDataUrl(screenshot);
  const sess = activeSession(req.user.class_id);
  const inClass = sess && sess.lesson_id === +lesson_id && req.pc;
  const group = groupFor(inClass ? sess : null, req.user, req.pc);
  for (const m of group) {
    const isMe = m.id === req.user.id;
    run(`INSERT INTO lesson_status(student_id,lesson_id,finished_at,screenshot,self_assess,reflection) VALUES(?,?,CURRENT_TIMESTAMP,?,?,?)
      ON CONFLICT(student_id,lesson_id) DO UPDATE SET finished_at=CURRENT_TIMESTAMP, screenshot=COALESCE(excluded.screenshot,screenshot),
      self_assess=COALESCE(excluded.self_assess,self_assess), reflection=COALESCE(excluded.reflection,reflection)`,
    m.id, lesson_id, shot, isMe ? JSON.stringify(self_assess || null) : null, isMe ? (reflection || null) : null);
  }
  const names = all(`SELECT name FROM users WHERE id IN (${group.map(g => g.id).join(',')})`).map(r => r.name);
  const id = run('INSERT INTO submissions(student_id,lesson_id,session_id,kind,text,file,group_ids) VALUES(?,?,?,?,?,?,?)',
    req.user.id, lesson_id, inClass ? sess.id : null, 'finish', reflection || '', shot, JSON.stringify(group.map(g => g.id))).lastInsertRowid;
  const title = get('SELECT title FROM lessons WHERE id=?', lesson_id).title;
  io.to('teacher').emit('finish', { id, session_id: inClass ? sess.id : null, student_ids: group.map(g => g.id) });
  notifyTeachers(`✅ ${req.pc ? 'ПК ' + req.pc + ': ' : '🏠 '}${names.join(', ')} — завершили «${title}»`, inClass ? `#/live/${sess.id}` : '#/submissions');
  return { ok: true, screenshot: shot };
}));

// Втрата фокусу (учень пішов з вікна під час демонстрації)
const focusAlerts = new Map();

// ======================================================================
// Оцінки, підтвердження вмінь, журнал
// ======================================================================
app.post('/api/grades', auth, teacher, h(req => {
  const { student_id, lesson_id, kind, value, comment } = req.body;
  if (!String(value || '').trim()) bad('Вкажіть оцінку');
  const id = run('INSERT INTO grades(student_id,lesson_id,kind,value,comment) VALUES(?,?,?,?,?)', student_id, lesson_id || null, kind || 'Практична робота', String(value).trim(), comment || '').lastInsertRowid;
  const t = lesson_id ? get('SELECT title FROM lessons WHERE id=?', lesson_id)?.title : '';
  notifyStudent(student_id, `📝 Нова оцінка: ${value}${t ? ' — «' + t + '»' : ''}${comment ? '. ' + comment : ''}`, '#/grades');
  return { id };
}));
app.delete('/api/grades/:id', auth, teacher, h(req => { run('DELETE FROM grades WHERE id=?', req.params.id); return { ok: true }; }));
app.put('/api/mastery', auth, teacher, h(req => {
  const { student_id, lesson_id, mastery } = req.body;
  run(`INSERT INTO lesson_status(student_id,lesson_id,mastery) VALUES(?,?,?) ON CONFLICT(student_id,lesson_id) DO UPDATE SET mastery=excluded.mastery`, student_id, lesson_id, mastery ?? null);
  io.to('teacher').emit('live:changed', {});
  return { ok: true };
}));

app.get('/api/classes/:id/journal', auth, teacher, h(req => {
  const cls = get('SELECT * FROM classes WHERE id=?', req.params.id);
  if (!cls?.course_id) return { cls, students: [], lessons: [], cells: {} };
  const students = studentsOf(cls.id).map(s => ({ id: s.id, name: s.name }));
  const lessons = all(`SELECT l.id, l.title, u.title unit FROM lessons l JOIN units u ON u.id=l.unit_id WHERE u.course_id=? ORDER BY u.position, u.id, l.position, l.id`, cls.course_id);
  const cells = lessonStatusMap(students.map(s => s.id), lessons.map(l => l.id), cls.id);
  const grades = {};
  for (const g of all(`SELECT * FROM grades WHERE student_id IN (SELECT id FROM users WHERE class_id=?)`, cls.id)) ((grades[g.student_id] ||= {})[g.lesson_id || 0] ||= []).push(g);
  const sessions = all(`SELECT id, lesson_id, date, status, cancel_reason FROM sessions WHERE class_id=? ORDER BY date`, cls.id);
  const hands = Object.fromEntries(all(`SELECT s.student_id, SUM(s.was_driver) d, COUNT(*) n FROM seating s JOIN sessions x ON x.id=s.session_id WHERE x.class_id=? GROUP BY s.student_id`, cls.id).map(r => [r.student_id, r]));
  students.forEach(s => { s.driver = hands[s.id]?.d || 0; s.seated = hands[s.id]?.n || 0; });
  return { cls, students, lessons, cells, grades, sessions };
}));

app.get('/api/students/:id/profile', auth, teacher, h(req => {
  const st = get("SELECT id, name, login, pw_plain, class_id FROM users WHERE id=? AND role='student'", req.params.id);
  if (!st) bad('Учня не знайдено');
  const cls = get('SELECT * FROM classes WHERE id=?', st.class_id);
  const lessonIds = cls?.course_id ? lessonIdsOfCourse(cls.course_id) : [];
  const lessons = lessonIds.length ? all(`SELECT id, title FROM lessons WHERE id IN (${lessonIds.join(',')})`) : [];
  const status = lessonStatusMap([st.id], lessonIds, st.class_id)[st.id] || {};
  return {
    student: st, cls, lessons: lessonIds.map(id => ({ ...lessons.find(l => l.id === id), status: status[id] })),
    grades: all('SELECT g.*, l.title lesson_title FROM grades g LEFT JOIN lessons l ON l.id=g.lesson_id WHERE student_id=? ORDER BY g.id DESC', st.id),
    logins: all('SELECT * FROM login_log WHERE user_id=? ORDER BY id DESC LIMIT 50', st.id),
    attendance: all(`SELECT a.status, x.date, l.title FROM attendance a JOIN sessions x ON x.id=a.session_id LEFT JOIN lessons l ON l.id=x.lesson_id WHERE a.student_id=? ORDER BY x.date DESC`, st.id),
    seats: all(`SELECT s.computer_no, s.role, s.was_driver, x.date, (SELECT GROUP_CONCAT(u.name, ', ') FROM seating s2 JOIN users u ON u.id=s2.student_id WHERE s2.session_id=s.session_id AND s2.computer_no=s.computer_no AND s2.student_id<>s.student_id) mates
      FROM seating s JOIN sessions x ON x.id=s.session_id WHERE s.student_id=? ORDER BY x.date DESC`, st.id),
  };
}));

// ======================================================================
// Домашні завдання та здані роботи
// ======================================================================
app.get('/api/homework', auth, teacher, h(req => all(`SELECT h.*, l.title lesson_title, c.name class_name,
  (SELECT COUNT(*) FROM submissions s WHERE s.homework_id=h.id) submitted FROM homework h LEFT JOIN lessons l ON l.id=h.lesson_id JOIN classes c ON c.id=h.class_id
  ${req.query.class_id ? 'WHERE h.class_id=' + parseInt(req.query.class_id, 10) : ''} ORDER BY h.id DESC`)));
app.post('/api/homework', auth, teacher, h(req => {
  const { class_id, lesson_id, text, due } = req.body;
  if (!String(text || '').trim()) bad('Опишіть завдання');
  const id = run('INSERT INTO homework(class_id,lesson_id,text,due) VALUES(?,?,?,?)', class_id, lesson_id || null, text, due || null).lastInsertRowid;
  for (const s of studentsOf(class_id)) notifyStudent(s.id, `🏠 Нове домашнє завдання${due ? ' (до ' + due + ')' : ''}`, '#/homework');
  return { id };
}));
app.delete('/api/homework/:id', auth, teacher, h(req => { run('DELETE FROM homework WHERE id=?', req.params.id); return { ok: true }; }));
app.post('/api/homework/:id/submit', auth, upload.single('file'), h(req => {
  const hw = get('SELECT * FROM homework WHERE id=? AND class_id=?', req.params.id, req.user.class_id);
  if (!hw) bad('Завдання не знайдено');
  const file = req.file ? '/uploads/' + req.file.filename : null;
  run('DELETE FROM submissions WHERE homework_id=? AND student_id=?', hw.id, req.user.id);
  run('INSERT INTO submissions(student_id,lesson_id,homework_id,kind,text,file) VALUES(?,?,?,?,?,?)', req.user.id, hw.lesson_id, hw.id, 'homework', req.body.text || '', file);
  notifyTeachers(`📨 ${req.user.name} здав(ла) домашнє завдання`, '#/submissions');
  return { ok: true };
}));
app.get('/api/submissions', auth, teacher, h(req => all(`SELECT s.*, u.name, c.name class_name, l.title lesson_title, h.text hw_text FROM submissions s
  JOIN users u ON u.id=s.student_id JOIN classes c ON c.id=u.class_id LEFT JOIN lessons l ON l.id=s.lesson_id LEFT JOIN homework h ON h.id=s.homework_id
  WHERE 1=1 ${req.query.class_id ? 'AND u.class_id=' + parseInt(req.query.class_id, 10) : ''} ${req.query.unseen ? 'AND s.seen=0' : ''}
  ORDER BY s.id DESC LIMIT 300`).map(s => ({ ...s, group_names: s.group_ids ? all(`SELECT name FROM users WHERE id IN (${JSON.parse(s.group_ids).map(Number).join(',') || 0})`).map(r => r.name) : [] }))));
app.put('/api/submissions/:id/seen', auth, teacher, h(req => { run('UPDATE submissions SET seen=1 WHERE id=?', req.params.id); return { ok: true }; }));

// ======================================================================
// Кабінет учня
// ======================================================================
app.get('/api/student/home', auth, h(req => {
  if (req.user.role !== 'student') bad('Лише для учнів');
  const me = req.user;
  const cls = get('SELECT * FROM classes WHERE id=?', me.class_id);
  const course = cls?.course_id ? courseTree(cls.course_id) : null;
  const ids = course ? course.units.flatMap(u => u.lessons.map(l => l.id)) : [];
  const status = lessonStatusMap([me.id], ids, me.class_id)[me.id] || {};
  if (course) course.units.forEach(u => u.lessons.forEach(l => { l.status = status[l.id]; }));
  const sess = activeSession(me.class_id);
  let session = null;
  if (sess) {
    session = { id: sess.id, lesson_id: sess.lesson_id, mode: sess.mode, title: get('SELECT title FROM lessons WHERE id=?', sess.lesson_id)?.title, pc: req.pc };
    const seat = get('SELECT * FROM seating WHERE session_id=? AND student_id=?', sess.id, me.id);
    if (seat) session.seat = { ...seat, mates: all('SELECT u.name, s.role FROM seating s JOIN users u ON u.id=s.student_id WHERE s.session_id=? AND s.computer_no=? AND s.student_id<>?', sess.id, seat.computer_no, me.id) };
  }
  const homework = all(`SELECT h.*, l.title lesson_title, (SELECT created_at FROM submissions s WHERE s.homework_id=h.id AND s.student_id=?) submitted
    FROM homework h LEFT JOIN lessons l ON l.id=h.lesson_id WHERE h.class_id=? ORDER BY COALESCE(h.due,'9999') ASC, h.id DESC`, me.id, me.class_id);
  const grades = all('SELECT g.*, l.title lesson_title FROM grades g LEFT JOIN lessons l ON l.id=g.lesson_id WHERE g.student_id=? ORDER BY g.id DESC', me.id);
  const debts = ids.filter(id => ['missed', 'cancelled', 'partial', 'idle'].includes(status[id]?.state) || (status[id]?.state === 'done_group'));
  const due = get(`SELECT COUNT(*) n FROM training WHERE student_id=? AND due<=?`, me.id, U.today()).n;
  const notifications = all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 20', me.id);
  return { me, cls, course, session, homework, grades, debts, training_due: due, notifications };
}));

// Тренування: інтервальне повторення (коробки Лейтнера)
const BOX_DAYS = [0, 1, 2, 4, 8, 16];
app.get('/api/training', auth, h(req => {
  const me = req.user;
  const cls = get('SELECT * FROM classes WHERE id=?', me.class_id);
  if (!cls?.course_id) return { questions: [] };
  // питання з уроків, які учень почав або які вже проводилися з класом
  const lessonIds = all(`SELECT DISTINCT l.id FROM lessons l JOIN units u ON u.id=l.unit_id WHERE u.course_id=? AND (
      l.id IN (SELECT st.lesson_id FROM progress p JOIN steps st ON st.id=p.step_id WHERE p.student_id=?)
      OR l.id IN (SELECT lesson_id FROM sessions WHERE class_id=?))`, cls.course_id, me.id, cls.id).map(r => r.id);
  if (!lessonIds.length) return { questions: [] };
  const today = U.today();
  const qs = all(`SELECT q.id, q.text, q.options, q.lesson_id, l.title lesson_title, t.box, t.due FROM questions q JOIN lessons l ON l.id=q.lesson_id
    LEFT JOIN training t ON t.question_id=q.id AND t.student_id=? WHERE q.lesson_id IN (${lessonIds.join(',')}) AND (t.due IS NULL OR t.due<=?)`, me.id, today);
  qs.sort((a, b) => (a.box || 0) - (b.box || 0) || Math.random() - 0.5);
  return { questions: qs.slice(0, 8).map(q => ({ ...q, options: JSON.parse(q.options) })) };
}));
app.post('/api/training/answer', auth, h(req => {
  const q = get('SELECT * FROM questions WHERE id=?', req.body.question_id);
  if (!q) bad('Питання не знайдено');
  const ok = +req.body.choice === q.correct;
  const t = get('SELECT * FROM training WHERE student_id=? AND question_id=?', req.user.id, q.id) || { box: 1 };
  const box = ok ? Math.min(5, (t.box || 1) + 1) : 1;
  run(`INSERT INTO training(student_id,question_id,box,due,right_count,wrong_count) VALUES(?,?,?,?,?,?)
    ON CONFLICT(student_id,question_id) DO UPDATE SET box=excluded.box, due=excluded.due, right_count=right_count+?, wrong_count=wrong_count+?`,
  req.user.id, q.id, box, U.addDays(U.today(), BOX_DAYS[box]), ok ? 1 : 0, ok ? 0 : 1, ok ? 1 : 0, ok ? 0 : 1);
  return { correct: ok, correct_index: q.correct, explain: q.explain, box };
}));

app.get('/api/notifications', auth, h(req => all('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50', req.user.id)));
app.post('/api/notifications/read', auth, h(req => { run('UPDATE notifications SET read=1 WHERE user_id=?', req.user.id); return { ok: true }; }));

// ======================================================================
// Налаштування, кіоск-пристрої, коди розблокування
// ======================================================================
app.get('/api/settings', auth, teacher, h(() => ({ computers: setting('computers', 10), blocked_apps: setting('blocked_apps', []), unlock_ttl: setting('unlock_ttl', 15), close_kiosk_on_end: setting('close_kiosk_on_end', true) })));
app.put('/api/settings', auth, teacher, h(req => {
  const b = req.body;
  if (b.computers != null) setSetting('computers', Math.max(1, Math.min(60, parseInt(b.computers, 10) || 1)));
  if (Array.isArray(b.blocked_apps)) { setSetting('blocked_apps', b.blocked_apps.map(s => s.trim().toLowerCase()).filter(Boolean)); io.to('devices').emit('policy', { blocked_apps: setting('blocked_apps') }); }
  if (b.close_kiosk_on_end != null) setSetting('close_kiosk_on_end', !!b.close_kiosk_on_end);
  if (b.unlock_ttl != null) setSetting('unlock_ttl', Math.max(1, parseInt(b.unlock_ttl, 10) || 15));
  return { ok: true };
}));

app.get('/api/devices', auth, teacher, h(() => all('SELECT id, computer_no, name, locked, last_seen, hotp_counter FROM devices ORDER BY computer_no').map(d => ({ ...d, online: deviceSockets.has(d.id) }))));
app.delete('/api/devices/:id', auth, teacher, h(req => { run('DELETE FROM devices WHERE id=?', req.params.id); return { ok: true }; }));
app.post('/api/devices/command', auth, teacher, h(req => {
  const { cmd, ids } = req.body; // cmd: lock | unlock | exit
  const targets = ids?.length ? ids : all('SELECT id FROM devices').map(d => d.id);
  for (const id of targets) {
    if (cmd === 'lock' || cmd === 'unlock') run('UPDATE devices SET locked=? WHERE id=?', cmd === 'lock' ? 1 : 0, id);
    if (cmd === 'exit') expectedExit.add(id);
    io.to('device:' + id).emit('device:' + cmd);
  }
  return { ok: true, count: targets.length };
}));
// Одноразовий код розблокування (онлайн): діє N хвилин, лише один раз
app.post('/api/unlock-codes', auth, teacher, h(req => {
  let code; do { code = String(crypto.randomInt(100000, 1000000)); } while (get('SELECT 1 FROM unlock_codes WHERE code=?', code));
  const ttl = setting('unlock_ttl', 15);
  const exp = new Date(Date.now() + ttl * 60000).toISOString();
  run('INSERT INTO unlock_codes(code,kind,expires_at) VALUES(?,?,?)', code, req.body.kind === 'exit' ? 'exit' : 'unlock', exp);
  return { code, expires_at: exp, kind: req.body.kind === 'exit' ? 'exit' : 'unlock' };
}));
app.get('/api/unlock-codes', auth, teacher, h(() => all('SELECT * FROM unlock_codes ORDER BY created_at DESC LIMIT 30')));
// Аварійний офлайн-код (HOTP) для конкретного ПК — працює навіть без інтернету
app.post('/api/devices/:id/offline-code', auth, teacher, h(req => {
  const d = get('SELECT * FROM devices WHERE id=?', req.params.id);
  if (!d) bad('Пристрій не знайдено');
  const c = d.hotp_counter + 1;
  run('UPDATE devices SET hotp_counter=? WHERE id=?', c, d.id);
  return { code: U.hotp(d.hotp_secret, c), computer_no: d.computer_no };
}));

// --- API самого кіоску ---
app.post('/api/device/register', h(req => {
  const { login, password, computer_no, name } = req.body;
  const t = get("SELECT * FROM users WHERE login=? AND role='teacher'", login);
  if (!t || !U.verifyPw(password, t.pw_hash)) bad('Потрібен логін і пароль вчителя');
  const key = crypto.randomBytes(24).toString('hex');
  const secret = crypto.randomBytes(20).toString('hex');
  run('DELETE FROM devices WHERE computer_no=?', +computer_no);
  run('INSERT INTO devices(computer_no,name,key,hotp_secret) VALUES(?,?,?,?)', +computer_no, name || null, key, secret);
  return { key, hotp_secret: secret, computer_no: +computer_no };
}));
const deviceByKey = key => (key ? get('SELECT * FROM devices WHERE key=?', key) : null);
app.post('/api/device/unlock', h(req => {
  const d = deviceByKey(req.body.key); if (!d) bad('Пристрій не зареєстровано');
  const code = String(req.body.code || '').trim();
  const c = get('SELECT * FROM unlock_codes WHERE code=?', code);
  if (c && !c.used_at && c.expires_at > new Date().toISOString()) {
    run('UPDATE unlock_codes SET used_at=CURRENT_TIMESTAMP, used_by=? WHERE code=?', 'ПК ' + d.computer_no, code);
    run('UPDATE devices SET locked=0 WHERE id=?', d.id);
    if (c.kind === 'exit') expectedExit.add(d.id);
    notifyTeachers(`🔓 ПК ${d.computer_no} розблоковано одноразовим кодом${c.kind === 'exit' ? ' (сервісний вихід)' : ''}`);
    return { ok: true, kind: c.kind };
  }
  for (let i = d.hotp_counter - 5; i <= d.hotp_counter + 20; i++) {
    if (i > 0 && U.hotp(d.hotp_secret, i) === code) {
      run('UPDATE devices SET locked=0, hotp_counter=MAX(hotp_counter,?) WHERE id=?', i, d.id);
      return { ok: true, kind: 'unlock', counter: i };
    }
  }
  bad('Код невірний, вже використаний або прострочений');
}));
app.get('/api/device/state', h(req => {
  const d = deviceByKey(req.query.key); if (!d) bad('Пристрій не зареєстровано');
  const s = get("SELECT id, mode FROM sessions WHERE status='active' ORDER BY id DESC LIMIT 1");
  return { locked: !!d.locked, computer_no: d.computer_no, mode: s ? s.mode : 'none', session_id: s?.id || null, blocked_apps: setting('blocked_apps', []) };
}));

// ======================================================================
// Статика
// ======================================================================
app.use('/uploads/screens', auth, teacher, express.static(path.join(UPLOADS, 'screens')));
app.use('/uploads', auth, express.static(UPLOADS));
app.use('/vendor/pdfjs', express.static(path.join(__dirname, '..', 'node_modules', 'pdfjs-dist', 'build')));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ======================================================================
// Реальний час (Socket.IO)
// ======================================================================
const online = new Map();        // userId -> Map(socketId -> {pc})
const deviceSockets = new Map(); // deviceId -> socketId
const expectedExit = new Set();   // кіоски, які закрито за командою вчителя (не тривога)

io.use((socket, next) => {
  const dk = socket.handshake.auth?.deviceKey;
  if (dk) {
    const d = deviceByKey(dk); if (!d) return next(new Error('device'));
    socket.device = d; return next();
  }
  const p = U.verifyToken(U.parseCookies(socket.handshake.headers.cookie).tok || socket.handshake.auth?.token);
  if (!p) return next(new Error('auth'));
  const u = get('SELECT id, role, name, class_id FROM users WHERE id=?', p.uid);
  if (!u) return next(new Error('auth'));
  socket.user = u; socket.pc = p.pc || null;
  next();
});

io.on('connection', socket => {
  if (socket.device) {
    const d = socket.device;
    deviceSockets.set(d.id, socket.id);
    expectedExit.delete(d.id);
    socket.join('devices'); socket.join('device:' + d.id);
    // ім'я ПК оновлюється при кожному підключенні (якщо комп'ютер перейменували)
    const host = String(socket.handshake.auth?.hostname || '').slice(0, 64);
    run('UPDATE devices SET last_seen=CURRENT_TIMESTAMP, name=COALESCE(NULLIF(?, \'\'), name) WHERE id=?', host, d.id);
    io.to('teacher').emit('devices:changed');
    socket.on('disconnect', () => {
      if (deviceSockets.get(d.id) === socket.id) deviceSockets.delete(d.id);
      io.to('teacher').emit('devices:changed');
      // Учень закрив кіоск / вимкнув чи перезавантажив ПК посеред уроку? (15 с — на випадок короткого збою мережі)
      setTimeout(() => {
        if (deviceSockets.has(d.id) || expectedExit.has(d.id)) return;
        if (get("SELECT 1 FROM sessions WHERE status='active'")) notifyTeachers(`⚠️ ПК ${d.computer_no}: кіоск зник під час уроку (закрито, перезавантаження або немає мережі)`);
      }, 15000);
    });
    socket.on('device:locked', locked => { run('UPDATE devices SET locked=? WHERE id=?', locked ? 1 : 0, d.id); io.to('teacher').emit('devices:changed'); });
    socket.on('device:killed', name => io.to('teacher').emit('notify', { text: `⛔ ПК ${d.computer_no}: закрито заборонену програму ${name}` }));
    return;
  }
  const u = socket.user;
  socket.join('user:' + u.id);
  if (u.role === 'teacher') socket.join('teacher');
  else {
    socket.join('class:' + u.class_id);
    if (!online.has(u.id)) online.set(u.id, new Map());
    online.get(u.id).set(socket.id, { pc: socket.pc });
    io.to('teacher').emit('presence', { student_id: u.id, online: true, pc: socket.pc });
  }

  socket.on('disconnect', () => {
    if (u.role !== 'student') return;
    const m = online.get(u.id); if (m) { m.delete(socket.id); if (!m.size) online.delete(u.id); }
    io.to('teacher').emit('presence', { student_id: u.id, online: online.has(u.id), pc: socket.pc });
  });

  // Учень залишив вікно під час демонстрації/блокування
  socket.on('focus', ({ lost }) => {
    if (u.role !== 'student') return;
    if (lost) focusAlerts.set(u.id, new Date().toISOString()); else focusAlerts.delete(u.id);
    io.to('teacher').emit('focus', { student_id: u.id, name: u.name, lost, pc: socket.pc });
  });

  // Синхронізація демонстрації (сторінка презентації, відео)
  socket.on('demo:state', data => {
    if (u.role !== 'teacher') return;
    const s = get("SELECT * FROM sessions WHERE id=?", data.session_id); if (!s) return;
    run('UPDATE sessions SET demo=? WHERE id=?', JSON.stringify(data.demo || {}), s.id);
    io.to('class:' + s.class_id).emit('demo:state', data.demo);
  });

  // WebRTC-сигналізація для демонстрації екрана вчителя (1 -> багато)
  socket.on('rtc:want', () => { if (u.role === 'student') io.to('teacher').emit('rtc:want', { sid: socket.id, student_id: u.id }); });
  socket.on('rtc:signal', ({ to, data }) => {
    // учень може надсилати сигнали лише вчителю, вчитель — будь-кому
    const target = io.sockets.sockets.get(to);
    if (!target) return;
    if (u.role !== 'teacher' && target.user?.role !== 'teacher') return;
    target.emit('rtc:signal', { from: socket.id, data });
  });
});

server.listen(PORT, () => console.log(`Навчальна система запущена: http://localhost:${PORT}`));
