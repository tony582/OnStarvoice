/** Local development gate. Never syncs, packages, installs or reloads Extension. */
import {readFile, readdir} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
async function files(directory, prefix = "") {
  const entries = await readdir(directory, {withFileTypes: true});
  const result = [];
  for (const entry of entries) {
    const name = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unsupported symlink: ${name}`);
    if (entry.isDirectory()) result.push(...await files(path.join(directory, entry.name), name));
    else result.push(name);
  }
  return result;
}
const protectedFiles = ["manifest.json", "background.js", "content-loader.js", "content-v2.js", "sidebar/sidebar-logic.js", "sidebar/state.js", "sidebar/task-center-ui.js", ...await files(path.join(root, "utils"), "utils")].filter(name => !name.endsWith(".DS_Store"));
for (const name of protectedFiles) {
  const current = await readFile(path.join(root, name));
  const shipping = await readFile(path.join(root, "extension-build", name));
  const baseline = execFileSync("git", ["show", `HEAD:${name}`], {cwd: root, maxBuffer: 24 * 1024 * 1024});
  if (digest(current) !== digest(shipping) || digest(current) !== digest(baseline)) throw new Error(`Protected collection file changed: ${name}`);
}
console.log(`PASS: ${protectedFiles.length} protected files match HEAD and the existing shipping snapshot.`);
for (const name of ["sidebar/ui-mode.js", "sidebar/ui-next.js", "sidebar/ui-next-icons.js", "sidebar/sidebar-ui.js"]) {
  execFileSync(process.execPath, ["--check", name], {cwd: root, stdio: "inherit"});
}
const tests = [
  "tests/extension-ui-compatibility.test.mjs", "tests/extension-ui-batch-wiring.test.mjs",
  "tests/capture-recovery-ui.test.mjs", "tests/capture/ai-relevance-prefilter-ui.test.mjs",
  "tests/capture/sidebar-capture-task-wiring.test.mjs", "tests/capture/sidebar-csv-export.test.mjs",
  "tests/task-center-ui.test.mjs", "tests/task-center.test.mjs",
];
execFileSync(process.execPath, ["--test", ...tests], {cwd: root, stdio: "inherit"});
console.log("PASS: local UI development gate. Real-node capture/sync/performance acceptance remains separate.");
