/**
 * 微博接口请求 main-world 桥
 *
 * 现象:内容脚本(isolated world)对 /ajax/statuses/mymblog 等接口请求会失败/返回空,
 * 但页面自身(main world)请求一切正常(profile/info 在 isolated 能成,mymblog 不行)。
 * 解决:把微博接口请求放到 main world 执行(与页面自身 fetch 完全一致),
 * 内容脚本通过 window.postMessage 桥接拿结果。
 *
 * 该脚本以 world:MAIN、run_at:document_start 注入(见 manifest)。
 */
(() => {
  if (window.__starvoiceWeiboBridgeReady) return;
  window.__starvoiceWeiboBridgeReady = true;

  window.addEventListener("message", async (event) => {
    const req = event.data;
    if (!req || req.__starvoiceWeiboFetch !== true || !req.id) return;
    // 仅允许同源相对路径(/ajax/...),避免被滥用
    if (typeof req.url !== "string" || !req.url.startsWith("/")) {
      window.postMessage(
        { __starvoiceWeiboFetchResult: true, id: req.id, ok: false, error: "bad url" },
        "*",
      );
      return;
    }

    let payload;
    try {
      const resp = await fetch(req.url, {
        credentials: "include",
        headers: {
          accept: "application/json, text/plain, */*",
          "x-requested-with": "XMLHttpRequest",
        },
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const json = await resp.json();
      payload = { __starvoiceWeiboFetchResult: true, id: req.id, ok: true, json };
      try {
        const n = Array.isArray(json?.data?.list)
          ? json.data.list.length
          : json?.data?.user?.screen_name || "ok";
        console.log("[StarVoice桥] ✓", req.url.split("?")[0], "→", n);
      } catch {}
    } catch (err) {
      payload = {
        __starvoiceWeiboFetchResult: true,
        id: req.id,
        ok: false,
        error: String((err && err.message) || err),
      };
      console.log("[StarVoice桥] ✗", req.url.split("?")[0], "→", payload.error);
    }
    window.postMessage(payload, "*");
  });
})();
