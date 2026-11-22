'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Номер ПК потрібен синхронно під час входу — отримуємо його одразу
const computerNo = ipcRenderer.sendSync('kiosk:info-sync');

contextBridge.exposeInMainWorld('kiosk', {
  get computerNo() { return computerNo; },
  isKiosk: true,
  capture: () => ipcRenderer.invoke('kiosk:capture'),
  setLayout: l => ipcRenderer.send('kiosk:layout', l),
  unlock: code => ipcRenderer.invoke('kiosk:unlock', code),
  register: d => ipcRenderer.invoke('kiosk:register', d),
  loggedIn: () => {}, loggedOut: () => {},
});
