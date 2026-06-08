const loaderKey = '__ONSTARVOICE_CONTENT_V2_IMPORT__';

if (!globalThis[loaderKey]) {
  globalThis[loaderKey] = import(chrome.runtime.getURL('content-v2.js')).catch((error) => {
    console.error('[onstarvoice] failed to load content-v2 module', error);
    delete globalThis[loaderKey];
  });
}
