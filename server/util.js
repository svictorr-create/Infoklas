'use strict';
const crypto = require('crypto');

// ---------- Паролі ----------
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPw(pw, stored) {
  if (!stored) return false;
  const [, salt, hash] = stored.split('$');
  const h = crypto.scryptSync(String(pw), salt, 32);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}

// Легкі для дітей паролі: латиниця без схожих літер + 2 цифри (напр. "tiger47").
const WORDS = ['tiger', 'panda', 'robot', 'pixel', 'rocket', 'lemon', 'mango', 'koala', 'zebra', 'comet',
  'cloud', 'river', 'storm', 'maple', 'tulip', 'otter', 'eagle', 'shark', 'whale', 'cactus', 'piano',
  'violin', 'magic', 'ninja', 'pirate', 'planet', 'moon', 'sun', 'star', 'lion', 'wolf', 'fox', 'bear',
  'frog', 'duck', 'kiwi', 'melon', 'berry', 'cookie', 'donut', 'yoda', 'turbo', 'laser', 'radar', 'sonic',
  'bison', 'hippo', 'gecko', 'cobra', 'falcon', 'dragon', 'castle', 'forest', 'ocean', 'island', 'jungle'];
function genPassword() {
  const w = WORDS[crypto.randomInt(WORDS.length)];
  return w + String(crypto.randomInt(10, 100));
}

// Транслітерація (КМУ 2010, спрощено) для логінів
const TR = { а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', "'": '', '’': '', ы: 'y', э: 'e', ё: 'io', ъ: '' };
function translit(s) {
  return String(s).toLowerCase().split('').map(c => (c in TR ? TR[c] : c)).join('')
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
}

// ---------- Токени (HMAC, без зовнішніх залежностей) ----------
let SECRET = null;
function setSecret(s) { SECRET = s; }
function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function signToken(payload, ttlSec = 60 * 60 * 24 * 30) {
  const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(tok) {
  if (!tok || typeof tok !== 'string' || !tok.includes('.')) return null;
  const [body, sig] = tok.split('.');
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.exp < Date.now() / 1000) return null;
    return p;
  } catch { return null; }
}
function parseCookies(str = '') {
  const out = {};
  str.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

// ---------- HOTP (RFC 4226) для офлайн-кодів розблокування кіоску ----------
function hotp(secretHex, counter, digits = 6) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', Buffer.from(secretHex, 'hex')).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

function today() { return new Date().toISOString().slice(0, 10); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); }

module.exports = { hashPw, verifyPw, genPassword, translit, setSecret, signToken, verifyToken, parseCookies, hotp, today, addDays };
