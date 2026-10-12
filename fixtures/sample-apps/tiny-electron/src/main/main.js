const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { saveNote, listNotes } = require('./notes-store');

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

ipcMain.handle('notes:save', async (_event, note) => saveNote(note));
ipcMain.handle('notes:list', async () => listNotes());
ipcMain.on('app:quit', () => app.quit());

app.whenReady().then(createWindow);
