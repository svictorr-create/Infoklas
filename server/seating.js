'use strict';
/*
 * Автоматична розсадка.
 * Педагогічна ідея (парне програмування «водій/штурман»):
 *  - «за клавіатуру» (driver) першими сідають ті, хто найменше працював руками на попередніх уроках
 *    і ті, хто пропустив минулий урок — щоб кожен отримав практику;
 *  - решта розподіляється як штурмани: сильніший учень підсаджується до слабшого водія
 *    (змішані за рівнем групи), уникаємо повтору вчорашніх пар;
 *  - посеред уроку вчитель тисне «Поміняти ролі» — і водій/штурман міняються.
 */
const { all, get } = require('./db');

function autoSeat(sessionId, studentIds, computers) {
  const sess = get('SELECT * FROM sessions WHERE id=?', sessionId);
  if (!studentIds.length || computers < 1) return [];

  const stats = new Map(studentIds.map(id => [id, { id, handsOn: 0, mastery: 0, missedLast: 0, lastPartners: new Set(), rnd: Math.random() }]));

  // скільки разів був за клавіатурою на уроках цього класу
  for (const r of all(`SELECT s.student_id, SUM(s.was_driver) n FROM seating s JOIN sessions x ON x.id=s.session_id
       WHERE x.class_id=? AND x.id<>? GROUP BY s.student_id`, sess.class_id, sessionId)) {
    if (stats.has(r.student_id)) stats.get(r.student_id).handsOn = r.n || 0;
  }
  // рівень: частка кроків, виконаних самостійно + підтверджені вміння
  for (const r of all(`SELECT student_id, SUM(via='self') self, COUNT(*) n FROM progress GROUP BY student_id`)) {
    if (stats.has(r.student_id)) stats.get(r.student_id).mastery += r.n ? r.self / r.n : 0;
  }
  for (const r of all(`SELECT student_id, AVG(mastery) m FROM lesson_status WHERE mastery IS NOT NULL GROUP BY student_id`)) {
    if (stats.has(r.student_id)) stats.get(r.student_id).mastery += r.m;
  }
  // минуле заняття класу: хто був відсутній, хто з ким сидів
  const prev = get(`SELECT id FROM sessions WHERE class_id=? AND id<? AND status<>'cancelled' ORDER BY id DESC LIMIT 1`, sess.class_id, sessionId);
  if (prev) {
    for (const r of all(`SELECT student_id FROM attendance WHERE session_id=? AND status='absent'`, prev.id)) {
      if (stats.has(r.student_id)) stats.get(r.student_id).missedLast = 1;
    }
    const seats = all('SELECT student_id, computer_no FROM seating WHERE session_id=?', prev.id);
    for (const a of seats) for (const b of seats) {
      if (a.student_id !== b.student_id && a.computer_no === b.computer_no && stats.has(a.student_id)) stats.get(a.student_id).lastPartners.add(b.student_id);
    }
  }

  const list = [...stats.values()];
  const groups = Math.min(computers, list.length);
  // водії: найменше практики, пропустили минулий урок, далі випадково
  list.sort((a, b) => a.handsOn - b.handsOn || b.missedLast - a.missedLast || a.rnd - b.rnd);
  const tables = [];
  for (let i = 0; i < groups; i++) tables.push({ computer_no: i + 1, members: [list[i]] });
  // штурмани: від найсильнішого до найслабшого -> до найслабшої групи з найменшою кількістю людей
  const rest = list.slice(groups).sort((a, b) => b.mastery - a.mastery || a.rnd - b.rnd);
  for (const st of rest) {
    let best = null, bestScore = Infinity;
    for (const t of tables) {
      const size = t.members.length;
      const strength = t.members.reduce((s, m) => s + m.mastery, 0) / size;
      const repeat = t.members.some(m => st.lastPartners.has(m.id)) ? 1 : 0;
      const score = size * 100 + repeat * 10 + strength;
      if (score < bestScore) { bestScore = score; best = t; }
    }
    best.members.push(st);
  }
  const out = [];
  for (const t of tables) t.members.forEach((m, i) => out.push({ student_id: m.id, computer_no: t.computer_no, role: i === 0 ? 'driver' : 'navigator' }));
  return out;
}

module.exports = { autoSeat };
