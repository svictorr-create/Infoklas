'use strict';
/*
 * ІнфоКлас — кіоск-клієнт (Lockdown) для учнівських комп'ютерів.
 *
 * Що робить:
 *  - запускається вручну вчителем (наприклад, Veyon → «Запустити програму»); після уроку закривається командою з сервера;
 *  - без параметра --open стартує з екраном блокування;
 *  - розблокувати можна лише одноразовим кодом вчителя (онлайн) або офлайн-кодом (HOTP), чи командою з панелі вчителя;
 *  - під час «Презентації», «Мого екрана» та «Увага!» вікно займає весь екран, завжди поверх інших і повертає фокус;
 *  - під час уроку закриває заборонені програми (браузери, ігри — список задає вчитель);
 *  - у режимі практичної — дозволяє інші програми, а крок інструкції показує маленьким вікном поверх усіх вікон;
 *  - робить знімок екрана, коли учень тисне «Я закінчив».
 */
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const HOSTNAME = os.hostname(); // ім'я комп'ютера в Windows / Linux
const platform = require('./platform');
const { io } = require('socket.io-client');

/*
 * Параметри запуску:
 *   --open            одразу показати вхід учня (без коду) — зручно, коли вчитель сам запускає кіоск через Veyon
 *   --from-login      кіоск запущено автозапуском в обліковому записі учня: після уроку він блокується, а не закривається
 *   --autostart=on    вмикає автозапуск з входом у систему (--autostart=off — вимикає)
 *   --restore-keys    лише повернути системні комбінації клавіш (Linux) і вийти — запускається при вході учня в систему
 */
const ARGS = process.argv.slice(1);
const hasArg = a => ARGS.includes(a);
const START_OPEN = hasArg('--open');
const FROM_LOGIN = hasArg('--from-login');

const CFG_FILE = path.join(app.getPath('userData'), 'config.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch {}
const saveCfg = () => fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2));

// Якщо кіоск минулого разу завершився аварійно (вимкнули світло), клавіші в Linux лишилися б вимкненими
// і для уроків інших вчителів. Цей режим лише повертає їх і виходить.
if (hasArg('--restore-keys')) {
  if (cfg.keysBackup?.saved) { cfg.keysBackup = platform.restoreShortcuts(cfg.keysBackup); saveCfg(); }
  app.exit(0);
}
const autostartArg = ARGS.find(a => a.startsWith('--autostart='));
if (autostartArg) {
  app.whenReady().then(() => { platform.setAutostart(app, autostartArg.endsWith('=on')); app.exit(0); });
}

if (!autostartArg && !hasArg('--restore-keys')) {
  if (!app.requestSingleInstanceLock()) app.exit(0);
  // Повторна команда з Veyon не запускає другу копію, а показує вже відкрите вікно
  app.on('second-instance', (e, argv) => {
    if (!win) return;
    win.show(); win.focus();
    if (argv.includes('--open') && locked && cfg.key) showApp();
  });
}

let win = null;          // основне вікно (веб-застосунок або екран блокування)
let locked = true;       // після старту — завжди заблоковано
let layout = 'locked';   // locked | work | panel
let labMode = 'none';    // режим уроку від сервера
let allowQuit = false;
let blockedApps = [];
let serverApps = [];   // програми для практичних робіт (з налаштувань вчителя)
let socket = null;

// ---------- HOTP для офлайн-розблокування ----------
function hotp(secretHex, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', Buffer.from(secretHex, 'hex')).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1e6).padStart(6, '0');
}

async function post(url, body) {
  const r = await fetch(cfg.server + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(6000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Помилка'), { server: true });
  return d;
}

// ---------- Вікно ----------
function createWindow() {
  win = new BrowserWindow({
    show: false, frame: false, fullscreen: true, kiosk: true, alwaysOnTop: true, skipTaskbar: true,
    autoHideMenuBar: true, closable: false, minimizable: false, backgroundColor: '#1d2433',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, devTools: !app.isPackaged },
  });
  win.on('close', e => { if (!allowQuit) e.preventDefault(); });
  win.on('blur', () => { if (mustHoldFocus()) setTimeout(() => { win.show(); win.focus(); win.moveTop(); }, 50); });
  win.on('minimize', e => { if (mustHoldFocus()) { e.preventDefault(); win.restore(); } });
  // Блокуємо небезпечні клавіші всередині вікна
  win.webContents.on('before-input-event', (e, i) => {
    const k = i.key.toLowerCase();
    if ((i.control && ['w', 'r', 'n', 't', 'p'].includes(k) && !i.shift) || k === 'f5' || k === 'f11' || k === 'f12' || (i.control && i.shift && k === 'i') || (i.alt && k === 'f4')) e.preventDefault();
  });
  // Навігація лише в межах сервера школи
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:') && !url.startsWith(cfg.server || '#')) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(cfg.server)) return { action: 'allow', overrideBrowserWindowOptions: { alwaysOnTop: layout !== 'work', autoHideMenuBar: true } };
    if (labMode === 'work' || labMode === 'none') shell.openExternal(url);
    return { action: 'deny' };
  });
  win.once('ready-to-show', () => win.show());
}
const mustHoldFocus = () => locked || ['demo', 'screen', 'lock'].includes(labMode);

function showLock() {
  locked = true; layout = 'locked';
  applyFull();
  win.loadFile(path.join(__dirname, 'lock.html'), { query: { pc: String(cfg.computer_no || '?') } });
  socket?.emit('device:locked', true);
}
function showApp() {
  locked = false;
  win.loadURL(cfg.server + '/#/');
  applyLayout(['demo', 'screen', 'lock'].includes(labMode) ? 'locked' : 'work');
  socket?.emit('device:locked', false);
}

// Linux: системні комбінації (Alt+Tab, Super, Ctrl+Alt+T…) вимкнені, поки треба тримати учня у вікні
function holdKeys(on) {
  if (!platform.isLinux) return;
  if (on && !cfg.keysBackup?.saved) cfg.keysBackup = platform.disableShortcuts(cfg.keysBackup || {});
  else if (!on && cfg.keysBackup?.saved) cfg.keysBackup = platform.restoreShortcuts(cfg.keysBackup);
  else return;
  saveCfg();
}
function applyFull() {
  holdKeys(true);
  win.setKiosk(true); win.setFullScreen(true); win.setAlwaysOnTop(true, 'screen-saver'); win.setSkipTaskbar(true);
  win.setResizable(false); win.show(); win.focus();
}
function applyLayout(l) {
  if (locked) { applyFull(); return; }
  if (['demo', 'screen', 'lock'].includes(labMode)) l = 'locked'; // вчитель тримає увагу — учень не може вийти
  layout = l;
  if (l === 'locked') return applyFull();
  if (l !== 'hide-for-shot') holdKeys(false);
  win.setKiosk(false); win.setFullScreen(false); win.setSkipTaskbar(false); win.setResizable(true);
  const wa = screen.getPrimaryDisplay().workArea;
  if (l === 'panel') {
    // Крок інструкції поверх усіх вікон — у правому верхньому куті
    win.setAlwaysOnTop(true, 'floating');
    win.setBounds({ x: wa.x + wa.width - 400, y: wa.y + 10, width: 390, height: 250 });
  } else if (l === 'hide-for-shot') {
    win.hide();
  } else {
    win.setAlwaysOnTop(false);
    win.setBounds(wa); win.show();
  }
}

// ---------- Зв'язок з сервером ----------
function connect() {
  socket = io(cfg.server, { auth: { deviceKey: cfg.key, hostname: HOSTNAME }, transports: ['websocket', 'polling'], reconnection: true });
  socket.on('connect', async () => {
    socket.emit('device:locked', locked);
    try {
      const r = await fetch(`${cfg.server}/api/device/state?key=${cfg.key}`).then(r => r.json());
      blockedApps = r.blocked_apps || []; serverApps = r.apps || []; labMode = r.mode || 'none';
      if (!locked) applyLayout(layout);
    } catch {}
  });
  socket.on('device:lock', () => showLock());
  socket.on('device:unlock', () => { if (locked) showApp(); });
  socket.on('device:exit', info => {
    // Кінець уроку: кіоск з автозапуску (обліковий запис учня) лише блокується, щоб ПК не лишався «вільним»
    if (info?.reason === 'lesson-end' && FROM_LOGIN) { showLock(); return; }
    allowQuit = true; app.quit();
  });
  socket.on('policy', p => { blockedApps = p.blocked_apps || []; if (p.apps) serverApps = p.apps; });
  socket.on('lab:mode', m => {
    labMode = m.mode || 'none';
    if (locked) return;
    applyLayout(['demo', 'screen', 'lock'].includes(labMode) ? 'locked' : (layout === 'locked' ? 'work' : layout));
  });
}

// ---------- Заборонені програми (Windows і Linux) ----------
function enforceApps() {
  if (!blockedApps.length) return;
  if (!locked && labMode === 'none') return; // поза уроком ПК вільний
  platform.processes(list => {
    const found = platform.findBlocked(list, blockedApps);
    const reported = new Set();
    for (const p of found) {
      platform.kill(p);
      if (!reported.has(p.name)) { reported.add(p.name); socket?.emit('device:killed', p.name); }
    }
  });
}

// ---------- IPC з веб-застосунком та екраном блокування ----------
ipcMain.on('kiosk:info-sync', e => { e.returnValue = { computerNo: cfg.computer_no || null, hostname: HOSTNAME }; });
ipcMain.handle('kiosk:info', () => ({ computerNo: cfg.computer_no, server: cfg.server }));
ipcMain.handle('kiosk:capture', async () => {
  const { width, height } = screen.getPrimaryDisplay().size;
  const scale = Math.min(1, 1600 / width);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) } });
  const img = sources[0]?.thumbnail;
  return img ? 'data:image/jpeg;base64,' + img.toJPEG(75).toString('base64') : null;
});
ipcMain.on('kiosk:layout', (e, l) => {
  if (l === 'hide-for-shot') { win.hide(); return; }
  if (l === 'locked') return applyLayout('locked');
  if (layout === 'hide-for-shot' || !win.isVisible()) win.show();
  applyLayout(l);
});
ipcMain.handle('kiosk:unlock', async (e, code) => {
  code = String(code || '').trim();
  try {
    const r = await post('/api/device/unlock', { key: cfg.key, code });
    if (r.counter) cfg.counter = Math.max(cfg.counter || 0, r.counter), saveCfg();
    if (r.kind === 'exit') { allowQuit = true; setTimeout(() => app.quit(), 300); return { ok: true }; }
    showApp(); return { ok: true };
  } catch (err) {
    if (err.server) return { ok: false, error: err.message };
    // Немає зв'язку — перевіряємо офлайн-код (HOTP) локально
    const from = (cfg.counter || 0) + 1;
    for (let i = from; i < from + 30; i++) {
      if (hotp(cfg.hotp_secret, i) === code) { cfg.counter = i; saveCfg(); showApp(); return { ok: true, offline: true }; }
    }
    return { ok: false, error: 'Немає зв\'язку з сервером, а офлайн-код невірний' };
  }
});
ipcMain.handle('kiosk:register', async (e, d) => {
  try {
    cfg.server = d.server.replace(/\/+$/, '');
    const r = await post('/api/device/register', { login: d.login, password: d.password, computer_no: d.computer_no, name: HOSTNAME });
    Object.assign(cfg, { key: r.key, hotp_secret: r.hotp_secret, computer_no: r.computer_no, counter: 0 });
    saveCfg();
    connect(); showLock();
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ---------- Робоча папка учня: Документи/InfoKlas/<Учень>/<Урок> ----------
// Файли для роботи від вчителя копіюються сюди; учень зберігає тут результати; "Я закінчив" забирає нові/змінені файли.
const DOCS = (() => { const d = app.getPath('documents'); return d === os.homedir() ? path.join(d, 'Documents') : d; })();
const WORK_ROOT = path.join(DOCS, 'InfoKlas');
const MANIFEST = '.infoklas.json';
const safeName = (s, max = 80) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, max) || 'без назви';
function folderOf(student, lesson) {
  const dir = path.join(WORK_ROOT, safeName(student), safeName(lesson));
  if (!dir.startsWith(WORK_ROOT + path.sep)) throw new Error('bad path');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const readMan = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')); } catch { return { orig: {}, sent: {} }; } };
const writeMan = (dir, m) => { try { fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(m)); if (platform.isWin) require('child_process').execFile('attrib', ['+h', path.join(dir, MANIFEST)], () => {}); } catch {} };
const isJunk = n => n === MANIFEST || n.startsWith('.') || n.startsWith('~$') || n.startsWith('.~lock') || /\.(tmp|crdownload|part)$/i.test(n);

ipcMain.handle('kiosk:folder-info', (e, { student, lesson }) => {
  const dir = folderOf(student, lesson);
  return { path: dir, files: fs.readdirSync(dir).filter(n => !isJunk(n)) };
});
ipcMain.handle('kiosk:folder-write', (e, { student, lesson, name, data }) => {
  const dir = folderOf(student, lesson);
  const n = safeName(name, 120), p = path.join(dir, n);
  if (fs.existsSync(p)) return { skipped: true };           // ніколи не перезаписуємо роботу учня
  fs.writeFileSync(p, Buffer.from(data));
  const st = fs.statSync(p), m = readMan(dir);
  m.orig[n] = { size: st.size, mtimeMs: st.mtimeMs }; writeMan(dir, m);
  return { ok: true };
});
ipcMain.handle('kiosk:folder-open', (e, { student, lesson }) => shell.openPath(folderOf(student, lesson)));
// Нові або змінені файли (результати), які ще не надсилалися в цьому вигляді
ipcMain.handle('kiosk:folder-collect', (e, { student, lesson }) => {
  const dir = folderOf(student, lesson), m = readMan(dir), out = [];
  let total = 0;
  for (const n of fs.readdirSync(dir)) {
    if (isJunk(n)) continue;
    const p = path.join(dir, n), st = fs.statSync(p);
    if (!st.isFile()) continue;
    const o = m.orig[n];
    const changed = !o || o.size !== st.size || st.mtimeMs > o.mtimeMs + 2000;
    const sentSame = m.sent[n] && m.sent[n].size === st.size && Math.abs(m.sent[n].mtimeMs - st.mtimeMs) < 1;
    if (!changed || st.size > 100 * 1024 * 1024 || total > 300 * 1024 * 1024) continue;
    total += st.size;
    out.push({ name: n, size: st.size, mtimeMs: st.mtimeMs, sent: !!sentSame, data: sentSame ? null : fs.readFileSync(p) });
  }
  return out;
});
ipcMain.handle('kiosk:folder-mark-sent', (e, { student, lesson, files }) => {
  const dir = folderOf(student, lesson), m = readMan(dir);
  for (const f of files) m.sent[f.name] = { size: f.size, mtimeMs: f.mtimeMs };
  writeMan(dir, m); return { ok: true };
});

// ---------- Програми для практичної роботи ----------
ipcMain.handle('kiosk:apps', () => serverApps.filter(a => platform.resolveApp(a)).map(({ id, name, icon }) => ({ id, name, icon })));
ipcMain.handle('kiosk:launch', (e, { id, student, lesson, name }) => {
  const a = serverApps.find(x => x.id === id); if (!a) return { ok: false };
  const extra = name ? [path.join(folderOf(student, lesson), safeName(name, 120))] : [];
  return { ok: platform.launchApp(a, extra) };
});
// Відкрити файл з робочої папки в програмі за замовчуванням (.docx -> Word / Writer)
ipcMain.handle('kiosk:open-file', async (e, { student, lesson, name }) => {
  const p = path.join(folderOf(student, lesson), safeName(name, 120));
  if (!fs.existsSync(p)) return { ok: false, error: 'Файл не знайдено в папці' };
  const err = await shell.openPath(p);
  return { ok: !err, error: err || null };
});

// ---------- Посилання від вчителя (тест тощо) — відкриваються у вікні кіоску ----------
const urlWins = new Map();
ipcMain.on('kiosk:open-url', (e, { id, url, lock, title }) => {
  if (!/^https?:\/\//i.test(url || '')) return;
  urlWins.get(id)?.destroy();
  const w = new BrowserWindow({
    width: 1200, height: 800, title: title || url, autoHideMenuBar: true, show: false,
    kiosk: !!lock, fullscreen: !!lock, alwaysOnTop: !!lock, closable: !lock, minimizable: !lock,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  if (lock) {
    // Режим тесту: на весь екран, закриває лише вчитель
    w.setAlwaysOnTop(true, 'screen-saver');
    w.on('blur', () => setTimeout(() => { if (!w.isDestroyed()) { w.show(); w.focus(); } }, 50));
    w.on('close', ev => { if (!w.allowClose && !allowQuit) ev.preventDefault(); });
    w.webContents.on('before-input-event', (ev, i) => { if ((i.alt && i.key === 'F4') || (i.control && i.key.toLowerCase() === 'w')) ev.preventDefault(); });
  }
  w.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/i.test(u)) w.loadURL(u); return { action: 'deny' }; });
  w.once('ready-to-show', () => { if (!lock) w.maximize(); w.show(); w.focus(); });
  w.on('closed', () => urlWins.delete(id));
  w.loadURL(url);
  urlWins.set(id, w);
});
ipcMain.on('kiosk:close-url', (e, { id }) => {
  for (const [k, w] of urlWins) if (!id || k === id) { w.allowClose = true; w.destroy(); }
});

// ---------- Старт ----------
if (!autostartArg && !hasArg('--restore-keys')) app.whenReady().then(() => {
  // Перехоплюємо системні комбінації, які можна перехопити (Alt+Tab/Ctrl+Alt+Del — див. README про політики Windows)
  ['CommandOrControl+Esc', 'Alt+F4', 'F11', 'CommandOrControl+Shift+Esc'].forEach(k => { try { globalShortcut.register(k, () => {}); } catch {} });
  createWindow();
  if (!cfg.key || !cfg.server) win.loadFile(path.join(__dirname, 'setup.html'));
  else { connect(); if (START_OPEN) showApp(); else showLock(); }
  setInterval(enforceApps, 4000);
});
app.on('before-quit', e => { if (!allowQuit) e.preventDefault(); else { holdKeys(false); for (const w of urlWins.values()) { w.allowClose = true; w.destroy(); } } });
app.on('window-all-closed', () => { if (allowQuit) app.quit(); });
