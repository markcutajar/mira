// What the desktop app adds to Mira's page (decision 45): a way to bring its window forward when a
// notification is clicked. Nothing else of the app or the machine is reachable from the page.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miraApp', { focus: () => ipcRenderer.send('mira:focus') });
