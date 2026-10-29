// What Mira's pop-up (decision 55) can do: hear which cards to show, say how tall they are, and pass
// on a click. Nothing else of the app or the machine is reachable from it.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popup', {
  onCards: (handler) => ipcRenderer.on('popup:cards', (_event, cards) => handler(cards)),
  size: (height) => ipcRenderer.send('popup:size', height),
  act: (action, id) => ipcRenderer.send('popup:act', action, id),
});
