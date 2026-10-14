/** Isolated UI rehearsal. Never executes sidebar-logic/background/content code. */
import http from "node:http";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.STARVOICE_UI_PREVIEW_PORT || 4178);
const fixture = path.join(root, "tests/fixtures/extension-ui");
const types = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png"};
const server = http.createServer(async (req, res) => {
  try {
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    let file;
    if (pathname === "/") file = path.join(fixture, "index.html");
    else if (pathname.startsWith("/__preview/")) file = path.resolve(fixture, pathname.slice(11));
    else if (/^\/(sidebar|utils|images)\//.test(pathname)) file = path.resolve(root, pathname.slice(1));
    else { res.writeHead(404).end(); return; }
    if (!(file.startsWith(fixture + path.sep) || ["sidebar", "utils", "images"].some(dir => file.startsWith(path.join(root, dir) + path.sep)))) { res.writeHead(403).end(); return; }
    if (file === path.join(root, "sidebar/sidebar-logic.js")) { res.writeHead(403).end("Collector excluded from UI rehearsal"); return; }
    let body = await readFile(file);
    if (file === path.join(root, "sidebar/sidebar.html")) {
      body = body.toString().replace("<head>", '<head><script src="/__preview/chrome-mock.js"></script>')
        .replace('src="sidebar-logic.js"', 'src="/__preview/fixture.js"');
    }
    res.writeHead(200, {"Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; frame-src 'self'; object-src 'none'"});
    res.end(body);
  } catch { res.writeHead(404).end("Not found"); }
});
server.listen(port, "127.0.0.1", () => console.log(`Isolated StarVoice UI preview: http://127.0.0.1:${port}/`));
