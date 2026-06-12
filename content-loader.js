(() => {
  if (!globalThis.__ONSTARVOICE_CONTENT_V2_IMPORT__) {
    globalThis.__ONSTARVOICE_CONTENT_V2_IMPORT__ = import(chrome.runtime.getURL('content-v2.js')).catch((error) => {
      console.error('[onstarvoice] failed to load content-v2 module', error);
      delete globalThis.__ONSTARVOICE_CONTENT_V2_IMPORT__;
    });
  }
})();
