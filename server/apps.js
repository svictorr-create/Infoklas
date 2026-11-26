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
  '📝 Collabora Writer | C:\\Program Files\\Collabora Office\\program\\soffice.exe --writer | /opt/collaboraoffice/program/soffice --writer; collaboraoffice --writer',
  '📊 Collabora Calc | C:\\Program Files\\Collabora Office\\program\\soffice.exe --calc | /opt/collaboraoffice/program/soffice --calc; collaboraoffice --calc',
  '📽 Collabora Impress | C:\\Program Files\\Collabora Office\\program\\soffice.exe --impress | /opt/collaboraoffice/program/soffice --impress; collaboraoffice --impress',
  '📝 TextMaker | textmaker.exe; C:\\Program Files\\SoftMaker Office 2024\\TextMaker.exe; C:\\Program Files\\SoftMaker Office NX\\TextMaker.exe; C:\\Program Files\\SoftMaker Office 2021\\TextMaker.exe; C:\\Program Files\\SoftMaker FreeOffice 2024\\TextMaker.exe; C:\\Program Files\\SoftMaker FreeOffice 2021\\TextMaker.exe | textmaker24; textmaker24free; textmaker21; textmaker21free; textmaker',
  '📊 PlanMaker | planmaker.exe; C:\\Program Files\\SoftMaker Office 2024\\PlanMaker.exe; C:\\Program Files\\SoftMaker Office NX\\PlanMaker.exe; C:\\Program Files\\SoftMaker Office 2021\\PlanMaker.exe; C:\\Program Files\\SoftMaker FreeOffice 2024\\PlanMaker.exe; C:\\Program Files\\SoftMaker FreeOffice 2021\\PlanMaker.exe | planmaker24; planmaker24free; planmaker21; planmaker21free; planmaker',
  '📽 Presentations | presentations.exe; C:\\Program Files\\SoftMaker Office 2024\\Presentations.exe; C:\\Program Files\\SoftMaker Office NX\\Presentations.exe; C:\\Program Files\\SoftMaker Office 2021\\Presentations.exe; C:\\Program Files\\SoftMaker FreeOffice 2024\\Presentations.exe; C:\\Program Files\\SoftMaker FreeOffice 2021\\Presentations.exe | presentations24; presentations24free; presentations21; presentations21free; presentations',
  '📝 ONLYOFFICE Документ | C:\\Program Files\\ONLYOFFICE\\DesktopEditors\\DesktopEditors.exe --new:word | onlyoffice-desktopeditors --new:word',
  '📊 ONLYOFFICE Таблиця | C:\\Program Files\\ONLYOFFICE\\DesktopEditors\\DesktopEditors.exe --new:cell | onlyoffice-desktopeditors --new:cell',
  '📽 ONLYOFFICE Презентація | C:\\Program Files\\ONLYOFFICE\\DesktopEditors\\DesktopEditors.exe --new:slide | onlyoffice-desktopeditors --new:slide',
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
