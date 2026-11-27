'use strict';
/*
 * Правила використання сервісів штучного інтелекту (ШІ) на уроці.
 * Вчитель обирає рівень для уроку (у редакторі) або прямо під час уроку.
 *   deny  — 🚫 заборонено: кіоск блокує сайти й програми ШІ
 *   help  — 💡 лише для пояснень і перевірки (не для готових відповідей)
 *   allow — ✅ дозволено, учень вказує, як використовував
 */
const LEVELS = {
  deny: { icon: '🚫', label: 'ШІ заборонено', hint: 'Виконуй самостійно. Сайти й програми штучного інтелекту на цьому уроці заблоковані.' },
  help: { icon: '💡', label: 'ШІ — лише для пояснень', hint: 'Можна попросити ШІ пояснити незрозуміле чи перевірити себе, але не робити завдання замість тебе. Наприкінці вкажи, як ти ним користувався.' },
  allow: { icon: '✅', label: 'ШІ дозволено', hint: 'Можна користуватися ШІ-помічниками. Наприкінці чесно вкажи, який сервіс і для чого використовував.' },
};
const norm = p => (LEVELS[p] ? p : 'deny');

// Кнопки ШІ-сервісів, які учень бачить, коли ШІ дозволено (рядок: іконка Назва | адреса)
const DEFAULT_SERVICES_TEXT = [
  '🤖 ChatGPT | https://chatgpt.com',
  '✨ Gemini | https://gemini.google.com',
  '🪁 Copilot | https://copilot.microsoft.com',
  '🧠 Claude | https://claude.ai',
].join('\n');

// Сайти ШІ, які кіоск блокує, коли ШІ заборонено (разом з адресами зі списку сервісів)
const HOSTS = ['chatgpt.com', 'chat.openai.com', 'openai.com', 'gemini.google.com', 'bard.google.com', 'aistudio.google.com', 'notebooklm.google.com',
  'copilot.microsoft.com', 'copilot.cloud.microsoft', 'claude.ai', 'perplexity.ai', 'deepseek.com', 'chat.deepseek.com', 'poe.com', 'grok.com',
  'character.ai', 'chat.mistral.ai', 'you.com', 'phind.com', 'huggingface.co', 'chat.qwen.ai', 'kimi.com', 'meta.ai', 'duck.ai', 'gptonline.ai',
  'brainly.com', 'znanija.com', 'photomath.com', 'mathway.com', 'quillbot.com'];
// Програми ШІ для ПК (назви процесів), які кіоск закриває, коли ШІ заборонено
const APPS = ['chatgpt.exe', 'claude.exe', 'copilot.exe', 'perplexity.exe', 'chatgpt', 'claude'];

function parseServices(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [title, url = ''] = line.split('|').map(s => s.trim());
    if (!/^https?:\/\//i.test(url)) continue;
    const m = /^(\p{Extended_Pictographic}️?)\s*(.+)$/u.exec(title || '');
    out.push({ id: 'ai' + (out.length + 1), icon: m ? m[1] : '🤖', name: (m ? m[2] : title || url).trim(), url });
  }
  return out;
}
function hostsFor(services) {
  const hs = new Set(HOSTS);
  for (const s of services) { try { hs.add(new URL(s.url).hostname.replace(/^www\./, '')); } catch {} }
  return [...hs];
}

module.exports = { LEVELS, norm, DEFAULT_SERVICES_TEXT, HOSTS, APPS, parseServices, hostsFor };
