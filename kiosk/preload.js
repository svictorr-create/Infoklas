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
  openUrl: (o) => ipcRenderer.send('kiosk:open-url', o),
  apps: {
    list: () => ipcRenderer.invoke('kiosk:apps'),
    launch: (o) => ipcRenderer.invoke('kiosk:launch', o),
    openFile: (o) => ipcRenderer.invoke('kiosk:open-file', o),
  },
  closeUrl: (id) => ipcRenderer.send('kiosk:close-url', { id }),
  folder: {
    info: (o) => ipcRenderer.invoke('kiosk:folder-info', o),
    write: (o) => ipcRenderer.invoke('kiosk:folder-write', o),
    open: (o) => ipcRenderer.invoke('kiosk:folder-open', o),
    collect: (o) => ipcRenderer.invoke('kiosk:folder-collect', o),
    markSent: (o) => ipcRenderer.invoke('kiosk:folder-mark-sent', o),
  },
  setLayout: l => ipcRenderer.send('kiosk:layout', l),
  unlock: code => ipcRenderer.invoke('kiosk:unlock', code),
  register: d => ipcRenderer.invoke('kiosk:register', d),
  loggedIn: () => {}, loggedOut: () => {},
});
