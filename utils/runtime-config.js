(function configureOnStarvoiceRuntime(root) {
  "use strict";

  // Source and production snapshots stay pinned to the production trust
  // origin. The snapshot script may replace this file with the explicit local
  // variant for a developer-only unpacked build.
  root.__ONSTARVOICE_API_BASE_URL__ =
    root.__ONSTARVOICE_API_BASE_URL__ || "https://voice.minilife.online";
  root.__ONSTARVOICE_BUILD_TARGET__ =
    root.__ONSTARVOICE_BUILD_TARGET__ || "production";
})(typeof globalThis !== "undefined" ? globalThis : self);
