// What the desktop app adds to Mira's page: a way to bring its window forward when a notification is
// clicked (decision 45), and its pop-up and the flash of its taskbar button (decision 55). Nothing
// else of the app or the machine is reachable from the page.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miraApp', {
  focus: () => ipcRenderer.send('mira:focus'),
  flash: () => ipcRenderer.send('mira:flash'),
  popup: (card) => ipcRenderer.send('mira:popup', card),
  unpop: (id) => ipcRenderer.send('mira:unpop', id),
  onPopup: (handler) => {
    ipcRenderer.removeAllListeners('mira:popup-action');
    ipcRenderer.on('mira:popup-action', (_event, action, id) => handler(action, id));
  },
});
