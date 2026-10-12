# tiny-electron ground truth

What a correct analysis should find. Used to measure REA's recall.

- Entry: `package.json` main → `src/main/main.js`
- Main process modules: `src/main/main.js`, `src/main/notes-store.js`
- Preload: `src/preload.js` (set via `webPreferences.preload` in main.js)
- Renderer: `src/renderer/index.html` → `renderer.js` → `view.js`
- Imports: main.js → notes-store.js; renderer.js → view.js; builtins `electron`, `path`, `fs`
- IPC channels:
  - `notes:save` — `ipcRenderer.invoke` (preload) → `ipcMain.handle` (main)
  - `notes:list` — `ipcRenderer.invoke` (preload) → `ipcMain.handle` (main)
  - `app:quit` — `ipcRenderer.send` (preload) → `ipcMain.on` (main)
- Bridge: `contextBridge.exposeInMainWorld('notesApi', {save, list, quit})`
- Renderer uses bridge: `window.notesApi.save`, `window.notesApi.list`
- Native add-ons: none
