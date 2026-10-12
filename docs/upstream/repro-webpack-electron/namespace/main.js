const e = require('electron');
const path = require('path');

e.app.whenReady().then(() => {
  new e.BrowserWindow({ webPreferences: { preload: path.join(__dirname, 'preload.js') } });
});
e.ipcMain.handle('ping', () => 'pong');
