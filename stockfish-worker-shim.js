// Loader shim for stockfish-18-lite-single.js
//
// Some hosts serve .wasm files with an incorrect Content-Type header
// (not "application/wasm"), which makes WebAssembly.compileStreaming /
// instantiateStreaming throw instead of compiling the module. Those are
// the only two WebAssembly APIs that check the response MIME type —
// WebAssembly.compile / instantiate on a raw ArrayBuffer don't care about
// it at all. This patches the streaming entry points so any code in this
// worker (including the Stockfish engine loaded below) transparently
// falls back to the ArrayBuffer path instead of failing.
//
// (The engine's own .wasm file location is handled separately, via a URL
// hash fragment the app appends when creating this worker — see
// analysis-board.html — rather than anything in this file.)
(function () {
  function toArrayBuffer(source) {
    var responsePromise = (source && typeof source.then === 'function') ? source : Promise.resolve(source);
    return responsePromise.then(function (response) {
      return response.arrayBuffer();
    });
  }

  if (typeof WebAssembly !== 'undefined') {
    WebAssembly.compileStreaming = function (source) {
      return toArrayBuffer(source).then(function (buffer) {
        return WebAssembly.compile(buffer);
      });
    };

    WebAssembly.instantiateStreaming = function (source, importObject) {
      return toArrayBuffer(source).then(function (buffer) {
        return WebAssembly.instantiate(buffer, importObject);
      });
    };
  }
})();

importScripts('stockfish-18-lite-single.js');
