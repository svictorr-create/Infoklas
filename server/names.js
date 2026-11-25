'use strict';
/*
 * Розпізнавання списку учнів з будь-якого джерела:
 *  - текст, скопійований зі сторінки класу в НЗ / Excel («1 ⇥ Андрієнко Марія Олегівна ⇥ ...»);
 *  - файли .xlsx / .xls / .csv / .txt (вивантаження журналу з НЗ, списки з Excel).
 * Знаходить стовпець з іменами, прибирає номери, зайві пробіли, по батькові (за бажанням), дублікати.
 */
const XLSX = require('xlsx');

const L = "А-ЯІЇЄҐA-Zа-яіїєґa-z'’ʼ`-";
const WORD = new RegExp(`^[А-ЯІЇЄҐA-Z][${L}]*$`);
const PATRONYMIC = /(ович|евич|йович|івна|ївна|овна|евна|ічна|инична|іч)$/i;
const HEADER = /^(№|n|п\/п|піб|п\.і\.б\.?|прізвище|ім'я|імʼя|ім’я|учень|учні|учениця|по батькові|клас|дата|оцінка|предмет)$/i;

const normApos = s => s.replace(/[’ʼ`]/g, "'");
const clean = s => normApos(String(s ?? '')).replace(/ /g, ' ').replace(/^\s*\d+\s*[.)]?\s+/, '').replace(/\s+/g, ' ').trim();

/** Чи схоже значення клітинки на «Прізвище Ім'я [По батькові]» */
function looksLikeName(v) {
  const s = clean(v);
  if (!s || s.length > 80 || HEADER.test(s)) return false;
  const w = s.split(' ');
  return w.length >= 2 && w.length <= 4 && w.every(x => WORD.test(x) && x.length >= 2);
}

function finalize(raw, keepPatronymic) {
  let w = clean(raw).split(' ');
  if (!keepPatronymic && w.length >= 3 && PATRONYMIC.test(w[2])) w = w.slice(0, 2);
  return w.slice(0, keepPatronymic ? 3 : 2).join(' ');
}

/** rows: масив рядків таблиці (масиви клітинок) */
function namesFromRows(rows, keepPatronymic) {
  rows = rows.map(r => (Array.isArray(r) ? r : [r]).map(c => (c == null ? '' : String(c))));
  const width = Math.max(0, ...rows.map(r => r.length));
  // 1) окремі стовпці «Прізвище» та «Ім'я» в заголовку
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const h = rows[i].map(c => clean(c).toLowerCase());
    const ci = h.findIndex(c => c === 'прізвище'), ni = h.findIndex(c => /^ім.я$/.test(c));
    if (ci >= 0 && ni >= 0) {
      const pi = h.findIndex(c => c === 'по батькові');
      const out = rows.slice(i + 1).map(r => [r[ci], r[ni], keepPatronymic && pi >= 0 ? r[pi] : ''].map(clean).filter(Boolean).join(' '))
        .filter(looksLikeName);
      return { names: out.map(n => finalize(n, keepPatronymic)), column: `«Прізвище» + «Ім'я»` };
    }
  }
  // 2) стовпець, у якому найбільше значень схожі на імена
  let best = -1, bestN = 0;
  for (let c = 0; c < width; c++) {
    const n = rows.filter(r => looksLikeName(r[c])).length;
    if (n > bestN) { bestN = n; best = c; }
  }
  if (best < 0) return { names: [], column: null };
  return { names: rows.map(r => r[best]).filter(looksLikeName).map(n => finalize(n, keepPatronymic)), column: best + 1 };
}

function parseText(text, keepPatronymic) {
  const rows = String(text || '').split(/\r?\n/).map(l => l.split(/\t|;/));
  // список без табуляцій: кожен рядок цілком
  const r = namesFromRows(rows, keepPatronymic);
  if (r.names.length) return r;
  return namesFromRows(String(text || '').split(/\r?\n/).map(l => [l]), keepPatronymic);
}

function decodeText(buf) {
  const utf = buf.toString('utf8');
  if (!utf.includes('�')) return utf.replace(/^﻿/, '');
  try { return new TextDecoder('windows-1251').decode(buf); } catch { return utf; }  // старі CSV з Excel/НЗ
}

function parseFile(buf, filename, keepPatronymic) {
  if (/\.(csv|txt|tsv)$/i.test(filename)) return parseText(decodeText(buf), keepPatronymic);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, cellText: true });
  let best = { names: [], column: null, sheet: null };
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
    const r = namesFromRows(rows, keepPatronymic);
    if (r.names.length > best.names.length) best = { ...r, sheet: name };
  }
  return best;
}

/** Унікальні імена + ті, що вже є в класі */
function dedupe(names, existing) {
  const key = s => normApos(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const ex = new Set(existing.map(key)), seen = new Set(), add = [], skipped = [];
  for (const n of names) {
    const k = key(n);
    if (ex.has(k) || [...ex].some(e => e.startsWith(k + ' ') || k.startsWith(e + ' '))) { skipped.push(n); continue; }
    if (seen.has(k)) continue;
    seen.add(k); add.push(n);
  }
  return { add, skipped };
}

module.exports = { parseText, parseFile, dedupe, looksLikeName, finalize };
