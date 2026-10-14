/** Build a review candidate WITHOUT syncing or touching extension-build/. */
import {mkdtemp, cp, readFile, writeFile, readdir, lstat, mkdir, access} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2] && path.resolve(process.argv[2]);
const classic = process.argv.includes("--classic");
if (!output || !output.endsWith(".zip")) throw new Error("Pass a NEW absolute .zip output path");
if (output.startsWith(path.join(repo, "extension-build") + path.sep)) throw new Error("Never write to the live snapshot");
try { await access(output); throw new Error("Output exists; choose a new candidate path"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const hash = buffer => createHash("sha256").update(buffer).digest("hex");
async function inventory(directory, prefix = "") {
  const result = {};
  for (const name of (await readdir(directory)).sort()) {
    if (name === ".DS_Store") continue;
    const relative = path.join(prefix, name), file = path.join(directory, name), stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error(`Symbolic link not allowed: ${file}`);
    if (stat.isDirectory()) Object.assign(result, await inventory(file, relative));
    else result[relative] = hash(await readFile(file));
  }
  return result;
}
const liveBefore = await inventory(path.join(repo, "extension-build"));
const stage = await mkdtemp(path.join(os.tmpdir(), "starvoice-ui-review-"));
for (const name of ["manifest.json", "background.js", "content-loader.js", "content-v2.js", "images", "sidebar", "utils"]) await cp(path.join(repo, classic ? "extension-build" : "", name), path.join(stage, name), {recursive: true, filter: p => path.basename(p) !== ".DS_Store"});
const manifest = JSON.parse(await readFile(path.join(stage, "manifest.json"), "utf8"));
const config = await readFile(path.join(stage, "utils/runtime-config.js"), "utf8");
if (!config.includes("https://voice.minilife.online") || !config.includes('"production"') || /https?:\/\/(localhost|127\.0\.0\.1)/.test(config)) throw new Error("Candidate is not using the approved production API origin");
const files = await inventory(stage);
if (Object.keys(files).some(name => /(?:^|\/)(?:\.env[^/]*|[^/]+\.(?:pem|crx|zip))$/.test(name))) throw new Error("Forbidden file in candidate");
const allowedPresentationChanges = new Set(["sidebar/sidebar.html", "sidebar/sidebar-ui.js", "sidebar/ui-mode.js", "sidebar/ui-next.js", "sidebar/ui-next.css", "sidebar/ui-next-icons.js", "sidebar/ui-next-icons.LICENSE.txt"]);
const changedFromLive = [...new Set([...Object.keys(liveBefore), ...Object.keys(files)])].filter(name => liveBefore[name] !== files[name]);
for (const name of changedFromLive) {
  if (!allowedPresentationChanges.has(name)) throw new Error(`Unexpected difference from live snapshot: ${name}`);
}
const coreNames = Object.keys(files).filter(name => /^(?:utils\/|background\.js$|content(?:-loader|-v2)\.js$|manifest\.json$|sidebar\/(?:sidebar-logic|state|task-center-ui)\.js$)/.test(name));
const base = execFileSync("git", ["rev-parse", "HEAD"], {cwd: repo, encoding: "utf8"}).trim();
for (const name of coreNames) {
  const baseline = execFileSync("git", ["show", `${base}:${name}`], {cwd: repo, maxBuffer: 24 * 1024 * 1024});
  if (hash(baseline) !== files[name]) throw new Error(`Core behavior changed: ${name}`);
}
await mkdir(path.dirname(output), {recursive: true});
execFileSync("zip", ["-q", "-r", output, "."], {cwd: stage});
const liveAfter = await inventory(path.join(repo, "extension-build"));
if (JSON.stringify(liveBefore) !== JSON.stringify(liveAfter)) throw new Error("Live snapshot changed during packaging; do not distribute");
const evidence = {purpose: classic ? "Unmodified classic rollback snapshot" : "UI review candidate, NOT a released update", base, manifestVersion: manifest.version, defaultUI: "legacy", optInScope: classic ? "not applicable" : "this browser profile only", liveSnapshotUntouched: true, unchangedCoreFiles: coreNames.length, changedFromLive, zipSha256: hash(await readFile(output)), files, stagingDirectory: stage};
await writeFile(output + ".evidence.json", JSON.stringify(evidence, null, 2) + "\n", {flag: "wx"});
console.log(JSON.stringify({output, evidence: output + ".evidence.json", unchangedCoreFiles: coreNames.length, liveSnapshotUntouched: true, stagingDirectory: stage}, null, 2));
