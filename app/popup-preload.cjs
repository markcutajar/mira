// What Mira's pop-up (decisions 55 and 57) can do: hear which cards to show and what came of a reply,
// say how tall they are, and pass on a click or a reply. Nothing else of the app or the machine is
// reachable from it.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popup', {
  onCards: (handler) => ipcRenderer.on('popup:cards', (_event, cards, quick) => handler(cards, quick)),
  onSaid: (handler) => ipcRenderer.on('popup:said', (_event, id, said) => handler(id, said)),
  size: (height) => ipcRenderer.send('popup:size', height),
  act: (action, id, value) => ipcRenderer.send('popup:act', action, id, value),
});
