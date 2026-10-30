// What the desktop app adds to Mira's page: a way to bring its window forward when a notification is
// clicked (decision 45), its pop-up and the flash of its taskbar button (decisions 55 and 57), with
// what came of each pop-up card, and taking an update, which closes the app and opens it again
// (decision 60). Nothing else of the app or the machine is reachable from the page.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miraApp', {
  focus: () => ipcRenderer.send('mira:focus'),
  flash: () => ipcRenderer.send('mira:flash'),
  popup: (card) => ipcRenderer.send('mira:popup', card),
  unpop: (id) => ipcRenderer.send('mira:unpop', id),
  update: () => ipcRenderer.invoke('mira:update'),
  onPopup: (handler) => {
    ipcRenderer.removeAllListeners('mira:popup-action');
    ipcRenderer.on('mira:popup-action', (_event, action, id, session) => handler(action, id, session ?? id));
  },
});
