'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { hashPw } = require('./util');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'screens'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'school.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '', criteria TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, course_id INTEGER REFERENCES courses(id) ON DELETE SET NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('teacher','student')),
  name TEXT NOT NULL, login TEXT UNIQUE NOT NULL, pw_hash TEXT NOT NULL, pw_plain TEXT,
  class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE, active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);

-- Навчальна траєкторія: курс -> розділи (теми) -> уроки
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY, course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  position INTEGER DEFAULT 0, title TEXT NOT NULL, goal TEXT DEFAULT '', why TEXT DEFAULT '');

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY, unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  position INTEGER DEFAULT 0, title TEXT NOT NULL,
  objectives TEXT DEFAULT '',        -- "Сьогодні я навчуся..."
  why TEXT DEFAULT '',               -- "Навіщо це мені"
  success_criteria TEXT DEFAULT '',  -- по рядку: "Я можу..."
  theory TEXT DEFAULT '',            -- короткий конспект (markdown)
  homework TEXT DEFAULT '');         -- типове домашнє завдання

-- Інструкційна картка: кроки практичної роботи
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY, lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  position INTEGER DEFAULT 0, text TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY, lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, -- presentation | card | video | image | file | link
  title TEXT, filename TEXT, url TEXT, mime TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);

-- Питання для тренування (інтервальне повторення)
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY, lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  text TEXT NOT NULL, options TEXT NOT NULL, correct INTEGER NOT NULL, explain TEXT DEFAULT '');

CREATE TABLE IF NOT EXISTS training (
  student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
  box INTEGER DEFAULT 1, due TEXT, right_count INTEGER DEFAULT 0, wrong_count INTEGER DEFAULT 0,
  PRIMARY KEY (student_id, question_id));

-- Проведення уроку (заняття) для класу
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY, class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  lesson_id INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
  date TEXT NOT NULL, status TEXT DEFAULT 'active', -- active | done | cancelled
  cancel_reason TEXT, mode TEXT DEFAULT 'work',      -- work | demo | screen | lock
  demo TEXT DEFAULT '{}', started_at TEXT DEFAULT CURRENT_TIMESTAMP, ended_at TEXT);

CREATE TABLE IF NOT EXISTS attendance (
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL, -- present | late | absent
  PRIMARY KEY (session_id, student_id));

-- Розсадка: хто за яким комп'ютером; role: driver (за клавіатурою) | navigator
CREATE TABLE IF NOT EXISTS seating (
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  computer_no INTEGER NOT NULL, role TEXT DEFAULT 'navigator', was_driver INTEGER DEFAULT 0,
  PRIMARY KEY (session_id, student_id));

-- Точна фіксація виконання кожного кроку кожним учнем
CREATE TABLE IF NOT EXISTS progress (
  student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  step_id INTEGER REFERENCES steps(id) ON DELETE CASCADE,
  session_id INTEGER, computer_no INTEGER,
  via TEXT DEFAULT 'self',  -- self (сам за клавіатурою / вдома) | group (у групі, спостерігав)
  place TEXT DEFAULT 'class', -- class | home
  clicked_by INTEGER, done_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (student_id, step_id));

-- Підсумок уроку для учня: завершення, самооцінювання, рефлексія, підтвердження вчителя
CREATE TABLE IF NOT EXISTS lesson_status (
  student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  lesson_id INTEGER REFERENCES lessons(id) ON DELETE CASCADE,
  finished_at TEXT, screenshot TEXT, self_assess TEXT, reflection TEXT,
  mastery INTEGER, -- NULL не перевірено | 0 не вміє | 1 вміє (підтверджує вчитель)
  PRIMARY KEY (student_id, lesson_id));

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY, student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  lesson_id INTEGER, session_id INTEGER, homework_id INTEGER,
  kind TEXT NOT NULL, -- finish | homework
  text TEXT, file TEXT, group_ids TEXT, seen INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS homework (
  id INTEGER PRIMARY KEY, class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
  lesson_id INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
  text TEXT NOT NULL, due TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS grades (
  id INTEGER PRIMARY KEY, student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  lesson_id INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
  kind TEXT DEFAULT 'Практична робота', value TEXT NOT NULL, comment TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);

-- Пояснення від вчителя до конкретного кроку (бачать усі, оцінюють зірочками)
CREATE TABLE IF NOT EXISTS explanations (
  id INTEGER PRIMARY KEY, step_id INTEGER REFERENCES steps(id) ON DELETE CASCADE,
  text TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS stars (
  explanation_id INTEGER REFERENCES explanations(id) ON DELETE CASCADE,
  student_id INTEGER REFERENCES users(id) ON DELETE CASCADE, value INTEGER NOT NULL,
  PRIMARY KEY (explanation_id, student_id));
CREATE TABLE IF NOT EXISTS help_requests (
  id INTEGER PRIMARY KEY, student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  step_id INTEGER REFERENCES steps(id) ON DELETE CASCADE, session_id INTEGER, computer_no INTEGER,
  question TEXT DEFAULT '', status TEXT DEFAULT 'open', explanation_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, answered_at TEXT);

CREATE TABLE IF NOT EXISTS login_log (
  id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  at TEXT DEFAULT CURRENT_TIMESTAMP, ip TEXT, computer_no INTEGER, client TEXT, place TEXT);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL, link TEXT, read INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);

-- Комп'ютери класу з кіоск-клієнтом
CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY, computer_no INTEGER NOT NULL, name TEXT, key TEXT UNIQUE NOT NULL,
  hotp_secret TEXT NOT NULL, hotp_counter INTEGER DEFAULT 0, locked INTEGER DEFAULT 1,
  last_seen TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS unlock_codes (
  code TEXT PRIMARY KEY, kind TEXT DEFAULT 'unlock', -- unlock | exit
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL, used_at TEXT, used_by TEXT);
`);

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function setting(key, def = null) {
  const r = get('SELECT value FROM settings WHERE key=?', key);
  return r ? JSON.parse(r.value) : def;
}
function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
}

// ---------- Секрет і перший запуск ----------
if (!setting('secret')) setSetting('secret', crypto.randomBytes(32).toString('hex'));
// Міграція: кількість комп'ютерів зберігається окремо для кожного уроку
if (!all("PRAGMA table_info(sessions)").some(c => c.name === 'computers')) db.exec('ALTER TABLE sessions ADD COLUMN computers INTEGER');
if (setting('computers') == null) setSetting('computers', 10);
if (setting('blocked_apps') == null) {
  setSetting('blocked_apps', ['chrome.exe', 'msedge.exe', 'firefox.exe', 'opera.exe', 'browser.exe',
    'steam.exe', 'epicgameslauncher.exe', 'minecraft.exe', 'javaw.exe', 'robloxplayerbeta.exe', 'discord.exe', 'telegram.exe']);
}

if (!get("SELECT id FROM users WHERE role='teacher'")) {
  const login = process.env.TEACHER_LOGIN || 'teacher';
  const pw = process.env.TEACHER_PASSWORD || 'teacher123';
  run("INSERT INTO users(role,name,login,pw_hash) VALUES('teacher',?,?,?)", 'Вчитель', login, hashPw(pw));
  console.log(`\n  Створено обліковий запис вчителя: ${login} / ${pw}  (змініть пароль у Налаштуваннях!)\n`);
  require('./seed')({ all, get, run, tx });
}

module.exports = { db, all, get, run, tx, setting, setSetting, DATA_DIR };
