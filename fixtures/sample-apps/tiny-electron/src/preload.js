const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notesApi', {
  save: (note) => ipcRenderer.invoke('notes:save', note),
  list: () => ipcRenderer.invoke('notes:list'),
  quit: () => ipcRenderer.send('app:quit'),
});
