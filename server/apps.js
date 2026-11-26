'use strict';
/*
 * Програми для практичних робіт, які кіоск показує кнопками («🧰 Програми»).
 * Рядок налаштування:  іконка Назва | Windows: команда; запасна команда | Linux: команда; запасна
 * Команда — назва .exe (шукається в реєстрі App Paths / PATH) або повний шлях; після неї — параметри.
 * Кнопку показано лише на ПК, де програму знайдено.
 */
const DEFAULT_APPS_TEXT = [
  '📝 Word | winword.exe |',
  '📊 Excel | excel.exe |',
  '📽 PowerPoint | powerpnt.exe |',
  '📝 LibreOffice Writer | soffice.exe --writer; C:\\Program Files\\LibreOffice\\program\\swriter.exe | libreoffice --writer',
  '📊 LibreOffice Calc | soffice.exe --calc; C:\\Program Files\\LibreOffice\\program\\scalc.exe | libreoffice --calc',
  '📽 LibreOffice Impress | soffice.exe --impress; C:\\Program Files\\LibreOffice\\program\\simpress.exe | libreoffice --impress',
  '🐱 Scratch | C:\\Program Files (x86)\\Scratch 3\\Scratch 3.exe; C:\\Program Files\\Scratch 3\\Scratch 3.exe; %LOCALAPPDATA%\\Programs\\Scratch 3\\Scratch 3.exe | scratch; scratch-desktop',
  '🎨 Paint | mspaint.exe | pinta; kolourpaint',
  '🗒 Блокнот | notepad.exe | xed; gedit; mousepad',
  '🧮 Калькулятор | calc.exe | gnome-calculator; galculator',
].join('\n');

function parseApps(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [title, win = '', lin = ''] = line.split('|').map(s => s.trim());
    if (!title) continue;
    const m = /^(\p{Extended_Pictographic}\uFE0F?)\s*(.+)$/u.exec(title);
    const icon = m ? m[1] : '🧰', name = (m ? m[2] : title).trim();
    const list = s => s.split(';').map(x => x.trim()).filter(Boolean);
    out.push({ id: 'app' + (out.length + 1), name, icon, win: list(win), linux: list(lin) });
  }
  return out;
}
const appsToText = apps => apps.map(a => `${a.icon} ${a.name} | ${a.win.join('; ')} | ${a.linux.join('; ')}`).join('\n');

module.exports = { DEFAULT_APPS_TEXT, parseApps, appsToText };
