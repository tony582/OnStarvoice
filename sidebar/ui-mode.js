/**
 * Optional presentation layer. No capture imports, messages, timers or migrations.
 * localStorage belongs to this extension origin in this browser profile, not the
 * tenant or chrome.storage.sync. Existing nodes therefore stay on the legacy UI.
 */
export const UI_MODE_KEY = "starvoice.sidebar.presentation.v1";

export function readMode(storage) {
  try { return storage.getItem(UI_MODE_KEY) === "next" ? "next" : "legacy"; }
  catch { return "legacy"; }
}

export function saveMode(storage, mode) {
  try { storage.setItem(UI_MODE_KEY, mode === "next" ? "next" : "legacy"); return true; }
  catch { return false; }
}

export function initializeMode({document, window, load = () => import("./ui-next.js")} = {}) {
  const menu = document.getElementById("dropdownMoreMenu");
  if (!menu) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dropdown-item";
  button.id = "menuBtnInterfaceMode";
  button.setAttribute("role", "menuitem");
  let adapter = null;
  let loading = false;
  let stylesheet = null;
  let storage;
  try { storage = window.localStorage; } catch { /* Keep the default UI. */ }
  const updateLabel = () => {
    button.textContent = adapter ? "切回经典界面" : "试用新版界面";
    button.setAttribute("title", "仅当前浏览器生效；不重载扩展、不改变采集参数");
  };
  updateLabel();
  menu.append(button);

  const closeMenu = () => {
    menu.classList.remove("is-active");
    document.getElementById("btnMoreMenu")?.setAttribute("aria-expanded", "false");
  };
  const inform = (text, type = "info") => window.showMessage?.(text, type);
  const loadStyles = () => new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("./ui-next.css", import.meta.url).href;
    link.onload = () => { link.onload = null; link.onerror = null; resolve(); };
    link.onerror = () => { link.remove(); reject(new Error("新版界面样式未能加载")); };
    stylesheet = link;
    document.head.append(link);
  });

  async function setMode(mode, {remember = true} = {}) {
    if (loading) return false;
    closeMenu();
    // Rollback is always available, including while a task is running. It only
    // restores DOM positions and removes CSS; it never unloads the sidebar.
    if (mode !== "next") {
      adapter?.unmount();
      adapter = null;
      stylesheet?.remove();
      stylesheet = null;
      document.documentElement.classList.remove("sv-next");
      if (remember && !saveMode(storage, "legacy")) inform("已切回经典界面，但本机未能保存选择。", "warning");
      updateLabel();
      document.getElementById("btnMoreMenu")?.focus();
      return true;
    }
    if (adapter) return true;
    loading = true;
    button.disabled = true;
    try {
      const [{mountNextUI}, state] = await Promise.all([load(), import("./state.js"), loadStyles()]);
      adapter = mountNextUI({document, window, state});
      if (remember && !saveMode(storage, "next")) inform("新版界面已开启，但本机未能保存选择。关闭后将恢复经典界面。", "warning");
      updateLabel();
      return true;
    } catch (error) {
      adapter?.unmount();
      adapter = null;
      stylesheet?.remove();
      stylesheet = null;
      document.documentElement.classList.remove("sv-next");
      saveMode(storage, "legacy");
      updateLabel();
      inform("新版界面加载失败，已保留经典界面。采集功能不变。", "warning");
      console.warn("[Sidebar presentation] Legacy fallback:", error);
      return false;
    } finally {
      loading = false;
      button.disabled = false;
    }
  }
  button.addEventListener("click", () => void setMode(adapter ? "legacy" : "next"));
  if (readMode(storage) === "next") void setMode("next", {remember: false});
  return {setMode, getMode: () => adapter ? "next" : "legacy"};
}

if (typeof document !== "undefined") {
  const start = () => initializeMode({document, window});
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, {once: true});
  else start();
}
