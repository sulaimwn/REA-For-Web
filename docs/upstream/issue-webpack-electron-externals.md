# [Bug] Electron APIs reached through webpack externals (`e.exports=require("electron")`) are not recognized

## Summary

When an Electron main-process bundle is built with webpack, `electron` is an
external module whose factory is `e.exports=require("electron")`. App code
reaches it through webpack's module require (`var r = n(4157)`). REA 6.4.0
doesn't treat that binding as an `electron` namespace, so every
`new r.BrowserWindow(...)`, `r.ipcMain.handle(...)`, etc. is invisible. The
same code written with `const e = require('electron')` is recovered fully.

This seems separate from #2094, which resolves Electron APIs passed as wrapper
*parameters*. Here the binding comes from a bundler module factory.

## Environment

- `rea-agents@6.4.0` (npm), Node 24.18.0, Windows 11 x64
- Command: `rea analyze-javascript-application <dir> --format json`

## Minimal reproduction

Two apps, each with `package.json` (`"main": "main.js"`) and the same `preload.js`:

```js
// preload.js (both)
const { ipcRenderer } = require('electron');
ipcRenderer.invoke('ping');
```

**A. Namespace alias** (`namespace/main.js`)

```js
const e = require('electron');
const path = require('path');

e.app.whenReady().then(() => {
  new e.BrowserWindow({ webPreferences: { preload: path.join(__dirname, 'preload.js') } });
});
e.ipcMain.handle('ping', () => 'pong');
```

**B. Same code, webpack shape** (`webpack/main.js`, unminified webpack 5 output with `electron` as an external)

```js
(() => {
  var __webpack_modules__ = {
    896: (module) => { module.exports = require('electron'); },
    928: (module) => { module.exports = require('path'); },
  };
  var __webpack_module_cache__ = {};
  function __webpack_require__(id) {
    var cached = __webpack_module_cache__[id];
    if (cached !== undefined) return cached.exports;
    var module = (__webpack_module_cache__[id] = { exports: {} });
    __webpack_modules__[id](module, module.exports, __webpack_require__);
    return module.exports;
  }
  var r = __webpack_require__(896);
  var p = __webpack_require__(928);
  r.app.whenReady().then(() => {
    new r.BrowserWindow({ webPreferences: { preload: p.join(__dirname, 'preload.js') } });
  });
  r.ipcMain.handle('ping', () => 'pong');
})();
```

## Results (`normalized_result.summary`)

| | A. namespace | B. webpack |
|---|---|---|
| `browser_windows` | 1 | **0** |
| `preload_entrypoints` | 1 | **0** |
| `ipc.operations` | 2 | 1 (renderer side only) |
| `ipc.main_handlers` | 1 | **0** |
| `ipc.paired_renderer_transmissions` | 1 | **0** |

In B, the graph still has an `electron-preload` node, but only through the generic
`property:preload` mechanism, not attached to a `browser-window`. No bundler
registration is reported for this single-file webpack runtime.

## Real-world impact

GitHub Desktop 3.6.5 (open source, MIT) ships a minified webpack `main.js`:

```js
(()=>{var e={ … 4157(e){"use strict";e.exports=require("electron")}, … }
```

Its main process does `this.window=new r.BrowserWindow(t)` (twice) and
`r.ipcMain.handle(e, …)` / `r.ipcMain.on(e, …)`. REA reports 0 BrowserWindows and
0 main-process IPC handlers, even when `main.js` is analyzed on its own (so this
isn't the result-budget issue in #2092). Minified builds rename
`__webpack_require__` (here `n`), so recognition can't rely on names.

## Suggested direction

When a module-map object's factory body is exactly `<module>.exports = require("<spec>")`
(webpack `commonjs`/`node-commonjs` externals), treat `const x = <require>(<id>)` in the
same bundle as a proven alias of `require("<spec>")`. The module map (object literal
of `id(e,t,n){…}` factories, inside the runtime IIFE) can be identified structurally.

Happy to share the repro files.
