const { ipcRenderer } = require('electron');
ipcRenderer.invoke('ping');
