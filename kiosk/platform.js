'use strict';
/*
 * Залежні від ОС частини кіоску: Windows і Linux (Linux Mint: Cinnamon, Xfce, MATE).
 *  - processes(): список процесів поточного користувача
 *  - kill(): закрити процес
 *  - setAutostart(): запуск разом із входом у систему
 *  - shortcuts.disable()/restore(): вимкнути/повернути системні комбінації клавіш (Alt+Tab, меню, термінал…) — лише Linux
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';

// "chrome.exe" і "chrome" — одна програма. У Linux назва процесу обрізана до 15 символів.
function normName(n) {
  n = String(n || '').trim().toLowerCase();
  if (n.endsWith('.exe')) n = n.slice(0, -4);
  return isLinux ? n.slice(0, 15) : n;
}

// Розбір виводу `ps -o pid=,comm=` (винесено окремо для тестів)
function parsePs(out) {
  return out.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const m = /^(\d+)\s+(.+)$/.exec(l);
    return m ? { pid: +m[1], name: m[2].trim() } : null;
  }).filter(Boolean);
}
function parseTasklist(out) {
  return out.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const c = l.split('","').map(x => x.replace(/"/g, ''));
    return { pid: +c[1], name: c[0] };
  }).filter(p => p.name && p.pid);
}

function processes(cb) {
  if (isWin) return execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true }, (e, out) => cb(e ? [] : parseTasklist(out)));
  if (isLinux) return execFile('ps', ['-u', String(os.userInfo().uid), '-o', 'pid=,comm='], (e, out) => cb(e ? [] : parsePs(out)));
  cb([]);
}

function kill(p) {
  if (isWin) return execFile('taskkill', ['/f', '/pid', String(p.pid)], { windowsHide: true }, () => {});
  try { process.kill(p.pid, 'SIGKILL'); } catch {}
}

// Які процеси з запущених заборонені (крім самого кіоску)
function findBlocked(list, blocked) {
  const want = new Set(blocked.map(normName).filter(Boolean));
  const self = normName(path.basename(process.execPath));
  return list.filter(p => p.pid !== process.pid && normName(p.name) !== self && want.has(normName(p.name)));
}

// ---------- Автозапуск ----------
function setAutostart(app, enable = true, appName = 'infoklas-kiosk') {
  if (!isLinux) { app.setLoginItemSettings({ openAtLogin: enable, args: ['--from-login'] }); return; }
  // AppImage передає свій шлях у $APPIMAGE; для .deb — шлях до виконуваного файлу
  const exec = process.env.APPIMAGE || process.execPath;
  const file = path.join(os.homedir(), '.config', 'autostart', appName + '.desktop');
  if (!enable) { try { fs.unlinkSync(file); } catch {} return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '[Desktop Entry]', 'Type=Application', 'Name=InfoKlas Kiosk', `Exec="${exec}" --from-login`,
    'X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-Delay=2', 'NoDisplay=true', 'Terminal=false', '',
  ].join('\n'));
}

// ---------- Системні комбінації клавіш (Linux) ----------
// Поки екран заблоковано або йде демонстрація, вимикаємо Alt+Tab, Super (меню), Ctrl+Alt+T (термінал),
// Ctrl+Alt+Del (вихід), Alt+F4, перемикання робочих столів. Значення зберігаються і потім повертаються.
const CINNAMON = {
  'org.cinnamon.desktop.keybindings.wm': ['switch-windows', 'switch-windows-backward', 'switch-applications', 'switch-applications-backward',
    'switch-group', 'switch-group-backward', 'switch-panels', 'switch-panels-backward', 'cycle-windows', 'cycle-windows-backward', 'cycle-group',
    'panel-run-dialog', 'minimize', 'close', 'show-desktop', 'switch-to-workspace-left', 'switch-to-workspace-right', 'switch-to-workspace-up',
    'switch-to-workspace-down', 'move-to-workspace-left', 'move-to-workspace-right', 'begin-move', 'begin-resize', 'toggle-maximized', 'unmaximize'],
  'org.cinnamon.desktop.keybindings.media-keys': ['terminal', 'logout', 'shutdown', 'screensaver', 'home', 'search', 'www', 'email', 'calculator'],
  'org.cinnamon.desktop.keybindings': ['looking-glass-keybinding'],
};
const CINNAMON_STR = { 'org.cinnamon.muffin': ['overlay-key'] }; // клавіша Super -> меню
const MATE = {
  'org.mate.Marco.global-keybindings': ['switch-windows', 'switch-windows-backward', 'switch-applications', 'switch-panels', 'cycle-windows',
    'cycle-panels', 'panel-main-menu', 'panel-run-dialog', 'run-command-terminal', 'show-desktop', 'switch-to-workspace-left', 'switch-to-workspace-right',
    'switch-to-workspace-up', 'switch-to-workspace-down'],
  'org.mate.Marco.window-keybindings': ['close', 'minimize', 'begin-move', 'begin-resize', 'toggle-maximized'],
};
const XFCE_PROPS = /^\/(xfwm4|commands)\/custom\/.*(Tab|F4|F2|F1|Delete|<Super>|Super_L|Super_R|Escape|<Primary><Alt>(t|d|l|Left|Right|Up|Down)|<Alt>F\d)/;

function desktop() {
  const d = (process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '').toLowerCase();
  if (d.includes('cinnamon')) return 'cinnamon';
  if (d.includes('xfce')) return 'xfce';
  if (d.includes('mate')) return 'mate';
  return 'other';
}
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim(); } catch { return null; } };

/**
 * backup — об'єкт, що зберігається в config.json. Якщо кіоск аварійно завершився з вимкненими клавішами,
 * при наступному restore() значення все одно повернуться з цієї копії.
 */
function disableShortcuts(backup) {
  if (!isLinux || backup.saved) return backup;
  const d = desktop(); const saved = [];
  if (d === 'cinnamon' || d === 'mate') {
    const arr = d === 'cinnamon' ? CINNAMON : MATE;
    const empty = d === 'cinnamon' ? '[]' : "'disabled'";
    for (const [schema, keys] of Object.entries(arr)) for (const k of keys) {
      const v = sh('gsettings', ['get', schema, k]);
      if (v === null) continue; // ключа немає в цій версії
      saved.push(['g', schema, k, v]); sh('gsettings', ['set', schema, k, empty]);
    }
    if (d === 'cinnamon') for (const [schema, keys] of Object.entries(CINNAMON_STR)) for (const k of keys) {
      const v = sh('gsettings', ['get', schema, k]);
      if (v !== null) { saved.push(['g', schema, k, v]); sh('gsettings', ['set', schema, k, "''"]); }
    }
  } else if (d === 'xfce') {
    const out = sh('xfconf-query', ['-c', 'xfce4-keyboard-shortcuts', '-l', '-v']) || '';
    for (const line of out.split('\n')) {
      const m = /^(\S+)\s+(.*)$/.exec(line.trim());
      if (!m || !XFCE_PROPS.test(m[1])) continue;
      saved.push(['x', m[1], m[2]]); sh('xfconf-query', ['-c', 'xfce4-keyboard-shortcuts', '-p', m[1], '-s', '']);
    }
  }
  return { saved, desktop: d };
}
function restoreShortcuts(backup) {
  if (!isLinux || !backup?.saved) return {};
  for (const s of backup.saved) {
    if (s[0] === 'g') sh('gsettings', ['set', s[1], s[2], s[3]]);
    else sh('xfconf-query', ['-c', 'xfce4-keyboard-shortcuts', '-p', s[1], '-s', s[2]]);
  }
  return {};
}

// ---------- Програми для практичних робіт («🧰 Програми» в кіоску) ----------
// Команда: "winword.exe", "soffice.exe --writer", "C:\Program Files\X\x.exe --arg", "libreoffice --calc"
function splitCommand(cmd) {
  const s = String(cmd || '').trim().replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);
  const exe = /^(.*?\.exe)(\s+.*)?$/i.exec(s);
  if (exe) return { file: exe[1].replace(/^"|"$/g, ''), args: (exe[2] || '').trim().split(/\s+/).filter(Boolean) };
  const [file, ...args] = s.split(/\s+/);
  return { file, args };
}
const fs_ = require('fs');
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 4000, windowsHide: true }); } catch { return ''; } };
function whereWin(exe) {
  // як «Пуск»: реєстр App Paths (Office, LibreOffice), потім PATH (notepad, mspaint, calc)
  for (const root of ['HKLM\\SOFTWARE', 'HKCU\\SOFTWARE', 'HKLM\\SOFTWARE\\WOW6432Node']) {
    const out = run('reg', ['query', `${root}\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve']);
    const m = /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(out);
    if (m) { const p = m[1].trim().replace(/^"|"$/g, '').replace(/%([^%]+)%/g, (x, v) => process.env[v] ?? x); if (fs_.existsSync(p)) return p; }
  }
  const w = run('where', [exe]).split(/\r?\n/).find(Boolean);
  return w ? w.trim() : null;
}
const appCache = new Map();
/** Перша доступна на цьому ПК команда з переліку або null */
function resolveApp(app) {
  const key = JSON.stringify([app.win, app.linux]);
  if (appCache.has(key)) return appCache.get(key);
  let found = null;
  for (const c of (isWin ? app.win : app.linux) || []) {
    const { file, args } = splitCommand(c);
    if (!file) continue;
    let full = null;
    if (isWin) full = /[\\/]/.test(file) ? (fs_.existsSync(file) ? file : null) : whereWin(file);
    else full = file.startsWith('/') ? (fs_.existsSync(file) ? file : null) : (run('which', [file]).trim() || null);
    if (full) { found = { file: full, args }; break; }
  }
  appCache.set(key, found);
  return found;
}
function launchApp(app, extraArgs = []) {
  const r = resolveApp(app);
  if (!r) return false;
  const { spawn } = require('child_process');
  spawn(r.file, [...r.args, ...extraArgs], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return true;
}

module.exports = { isWin, isLinux, normName, parsePs, parseTasklist, processes, kill, findBlocked, setAutostart, disableShortcuts, restoreShortcuts, desktop, splitCommand, resolveApp, launchApp };
