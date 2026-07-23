(function configureOnStarvoiceLocalRuntime(root) {
  "use strict";

  // This file is copied only by `sync-extension-build.zsh local`. It is kept
  // outside the extension source tree so the default production snapshot can
  // never pick localhost merely because an unpacked extension is in use.
  root.__ONSTARVOICE_API_BASE_URL__ = "http://localhost:3001";
  root.__ONSTARVOICE_BUILD_TARGET__ = "local";
})(typeof globalThis !== "undefined" ? globalThis : self);
