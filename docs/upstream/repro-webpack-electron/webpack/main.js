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
