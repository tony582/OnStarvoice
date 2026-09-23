import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['runners/android/src', 'server/services/capture-discovery', 'server/services/android-control', 'web/admin/src/pages/dispatch/android-discovery'];
const files = ['utils/capture/douyin-inline-text.js', 'server/routes/capture-discoveries.js', 'server/routes/android-control.js', 'server/routes/capture-discovery-management.js'];
async function visit(relative) {
  for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) await visit(name);
    else if (/\.(?:m?js|tsx?)$/u.test(name)) files.push(name);
  }
}
await Promise.all(roots.map(visit));
const failures = [];
let largest = {file: '', lines: 0};
for (const file of files) {
  const source = await readFile(path.join(root, file), 'utf8');
  const lines = source.trimEnd().split('\n').length;
  if (lines > largest.lines) largest = {file, lines};
  if (lines > 350) failures.push(`${file}: ${lines} lines exceeds the module limit of 350`);
  const imports = [...source.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/gu)].map(match => match[1]);
  for (const specifier of imports.filter(value => value.startsWith('.'))) {
    const target = path.relative(root, path.resolve(root, path.dirname(file), specifier)).replaceAll('\\', '/');
    if (file.startsWith('runners/') && target.startsWith('server/')) failures.push(`${file}: runner imports server implementation`);
    if (file.includes('/src/device/') && /\/src\/(core|storage|cloud)\//u.test(target)) failures.push(`${file}: device layer imports runner orchestration`);
    if (file.startsWith('server/services/') && target.startsWith('server/routes/')) failures.push(`${file}: service imports HTTP route`);
  }
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Android discovery boundaries passed: ${files.length} modules; largest ${largest.lines} lines (${largest.file}).`);
