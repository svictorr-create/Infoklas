// Режим демонстрації: презентація (PDF/зображення/відео), трансляція екрана вчителя (WebRTC), блокування "Увага!"
import { state, api, $, esc } from './core.js';

const RTC_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ---------- PDF ----------
let pdfjs = null;
const pdfCache = new Map();
async function loadPdf(url) {
  if (!pdfjs) {
    pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  }
  if (!pdfCache.has(url)) pdfCache.set(url, pdfjs.getDocument({ url, withCredentials: true }).promise);
  return pdfCache.get(url);
}
export async function renderPdfPage(container, url, page) {
  const doc = await loadPdf(url);
  const n = Math.max(1, Math.min(doc.numPages, page || 1));
  const p = await doc.getPage(n);
  const vp0 = p.getViewport({ scale: 1 });
  const w = container.clientWidth || window.innerWidth, hgt = container.clientHeight || window.innerHeight;
  const scale = Math.min(w / vp0.width, hgt / vp0.height) * (window.devicePixelRatio || 1);
  const vp = p.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = vp.width; canvas.height = vp.height;
  canvas.style.maxWidth = '100%'; canvas.style.maxHeight = '100%';
  await p.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  container.replaceChildren(canvas);
  return doc.numPages;
}
export async function renderMaterial(container, material, demo) {
  if (!material) { container.innerHTML = '<div class="demo-msg">👀 Дивись на вчителя</div>'; return 0; }
  if (material.kind === 'presentation' || /pdf/.test(material.mime || '') || /\.pdf$/i.test(material.url)) return renderPdfPage(container, material.url, demo.page);
  if (material.kind === 'image' || /^image/.test(material.mime || '')) { container.innerHTML = `<img src="${esc(material.url)}" class="demo-img">`; return 1; }
  if (material.kind === 'video' || /^video/.test(material.mime || '')) {
    let v = $('video', container);
    if (!v || v.dataset.src !== material.url) { container.innerHTML = `<video class="demo-img" src="${esc(material.url)}" data-src="${esc(material.url)}" playsinline></video>`; v = $('video', container); }
    if (demo.time != null && Math.abs(v.currentTime - demo.time) > 1.5) v.currentTime = demo.time;
    if (demo.playing) v.play().catch(() => {}); else v.pause();
    return 1;
  }
  container.innerHTML = `<div class="demo-msg">${esc(material.title)}</div>`;
  return 1;
}

// =====================================================================
// Учень
// =====================================================================
let layer = null, sessId = null, curMode = 'work', pc = null, teacherSid = null;

function onBlur() { if (curMode !== 'work') state.socket?.emit('focus', { lost: true }); }
function onFocus() { if (curMode !== 'work') state.socket?.emit('focus', { lost: false }); }
function onVis() { document.hidden ? onBlur() : onFocus(); }

export function initStudentDemo(socket) {
  socket.on('mode', m => applyMode(m.mode, m.session_id));
  socket.on('demo:state', d => layer && curMode === 'demo' && drawDemo(d));
  socket.on('session', s => { if (!s) applyMode('work'); });
  socket.on('rtc:signal', async ({ from, data }) => {
    teacherSid = from;
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        pc?.close();
        pc = new RTCPeerConnection(RTC_CFG);
        pc.onicecandidate = e => e.candidate && socket.emit('rtc:signal', { to: from, data: { ice: e.candidate } });
        pc.ontrack = e => { const v = $('#demo-video'); if (v) { v.srcObject = e.streams[0]; v.play().catch(() => {}); } };
        await pc.setRemoteDescription(data.sdp);
        await pc.setLocalDescription(await pc.createAnswer());
        socket.emit('rtc:signal', { to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.ice && pc) { try { await pc.addIceCandidate(data.ice); } catch {} }
  });
  socket.on('connect', () => { if (curMode === 'screen') socket.emit('rtc:want'); });
}

export async function applyMode(mode, sessionId) {
  if (sessionId) sessId = sessionId;
  curMode = mode || 'work';
  if (curMode === 'work' || curMode === 'none') {
    layer?.remove(); layer = null; pc?.close(); pc = null;
    window.removeEventListener('blur', onBlur); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVis);
    if (document.fullscreenElement && !state.kiosk) document.exitFullscreen().catch(() => {});
    state.kiosk?.setLayout?.('work');
    return;
  }
  state.kiosk?.setLayout?.('locked');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'demo-layer';
    document.body.append(layer);
    window.addEventListener('blur', onBlur); window.addEventListener('focus', onFocus); document.addEventListener('visibilitychange', onVis);
    // Захист від випадкових дій: блокуємо контекстне меню та гарячі клавіші в межах сторінки
    layer.addEventListener('contextmenu', e => e.preventDefault());
  }
  const fsBtn = !state.kiosk && !document.fullscreenElement ? '<button class="btn big primary" id="demo-fs">Натисни, щоб розгорнути на весь екран</button>' : '';
  if (curMode === 'lock') {
    layer.innerHTML = `<div class="demo-lock"><div class="eyes">👀</div><h1>Увага на вчителя!</h1><p>Руки від клавіатури та миші 🙂</p>${fsBtn}</div>`;
  } else if (curMode === 'screen') {
    layer.innerHTML = `<video id="demo-video" autoplay playsinline muted></video><div class="demo-bar">📺 Демонстрація екрана вчителя ${fsBtn}</div>`;
    pc?.close(); pc = null;
    state.socket?.emit('rtc:want');
  } else if (curMode === 'demo') {
    layer.innerHTML = `<div id="demo-stage" class="demo-stage"><div class="demo-msg">Завантаження…</div></div><div class="demo-bar">📽 Презентація вчителя ${fsBtn}</div>`;
    const d = await api(`/sessions/${sessId}/demo`);
    drawDemo(d.demo);
  }
  const b = $('#demo-fs');
  if (b) b.onclick = () => document.documentElement.requestFullscreen?.().then(() => b.remove()).catch(() => {});
}

let lastMat = null;
async function drawDemo(demo) {
  const stage = $('#demo-stage'); if (!stage) return;
  if (!demo.material || demo.material.id !== demo.material_id) {
    if (lastMat?.id === demo.material_id) demo.material = lastMat;
    else if (demo.material_id) { const d = await api(`/sessions/${sessId}/demo`); demo.material = d.demo.material; }
  }
  lastMat = demo.material;
  try { await renderMaterial(stage, demo.material, demo); } catch (e) { stage.innerHTML = `<div class="demo-msg">Не вдалося показати матеріал</div>`; }
}

// =====================================================================
// Вчитель: трансляція екрана 1 -> багато (WebRTC mesh; для класу до ~30 ПК у локальній мережі)
// =====================================================================
const peers = new Map(); // studentSocketId -> RTCPeerConnection
let shareStream = null;

export function teacherRtcInit(socket) {
  socket.on('rtc:want', ({ sid }) => { if (shareStream) offerTo(sid); });
  socket.on('rtc:signal', async ({ from, data }) => {
    const p = peers.get(from); if (!p) return;
    if (data.sdp) await p.setRemoteDescription(data.sdp);
    else if (data.ice) { try { await p.addIceCandidate(data.ice); } catch {} }
  });
}
async function offerTo(sid) {
  peers.get(sid)?.close();
  const p = new RTCPeerConnection(RTC_CFG);
  peers.set(sid, p);
  shareStream.getTracks().forEach(t => p.addTrack(t, shareStream));
  p.onicecandidate = e => e.candidate && state.socket.emit('rtc:signal', { to: sid, data: { ice: e.candidate } });
  p.onconnectionstatechange = () => { if (['failed', 'closed'].includes(p.connectionState)) peers.delete(sid); };
  await p.setLocalDescription(await p.createOffer());
  state.socket.emit('rtc:signal', { to: sid, data: { sdp: p.localDescription } });
}
export async function startScreenShare(onEnded) {
  shareStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
  shareStream.getVideoTracks()[0].addEventListener('ended', () => { stopScreenShare(); onEnded && onEnded(); });
  return shareStream;
}
export function stopScreenShare() {
  peers.forEach(p => p.close()); peers.clear();
  shareStream?.getTracks().forEach(t => t.stop()); shareStream = null;
}
export const isSharing = () => !!shareStream;
export const viewerCount = () => [...peers.values()].filter(p => p.connectionState === 'connected').length;
