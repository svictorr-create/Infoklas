'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Номер ПК потрібен синхронно під час входу — отримуємо його одразу
const info = ipcRenderer.sendSync('kiosk:info-sync') || {};
const computerNo = info.computerNo || null;
const hostname = info.hostname || null;

contextBridge.exposeInMainWorld('kiosk', {
  get computerNo() { return computerNo; },
  get hostname() { return hostname; },
  isKiosk: true,
  capture: () => ipcRenderer.invoke('kiosk:capture'),
  setLayout: l => ipcRenderer.send('kiosk:layout', l),
  unlock: code => ipcRenderer.invoke('kiosk:unlock', code),
  register: d => ipcRenderer.invoke('kiosk:register', d),
  loggedIn: () => {}, loggedOut: () => {},
});
