import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

// The launcher never runs a shell. It reads the host's run-appium.sh once, at setup, and records the exact
// node binary, Appium entry script, arguments and the three environment values so `up` can later spawn node
// directly (execFile-style, shell:false). The .sh itself is never executed.
const ENV_KEYS = ['JAVA_HOME', 'ANDROID_HOME', 'APPIUM_HOME'];
export const DEFAULT_APPIUM_LAUNCH_FILE = join('.local', 'share', 'starvoice', 'android-toolchain', 'run-appium.sh');

function expand(value, env, home) {
  let out = value.startsWith('~/') || value === '~' ? home + value.slice(1) : value;
  return out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gu, (_, name) => env[name] ?? process.env[name] ?? '');
}

// Split a command line into tokens, honouring simple single and double quotes; no other shell syntax is applied.
function tokenize(line) {
  const tokens = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/gu;
  for (const match of line.matchAll(pattern)) {
    tokens.push(match[1] !== undefined ? match[1].replace(/\\(.)/gu, '$1') : match[2] ?? match[3]);
  }
  return tokens;
}

/** Parse the text of a run-appium.sh into {node, entry, args, env}. Pure: fs and auto-detection stay in the resolver. */
export function parseAppiumLaunch(text, {home = homedir()} = {}) {
  if (typeof text !== 'string' || text.length > 64 * 1024) throw new Error('Appium launch file is missing or too large');
  const env = {};
  let exec = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const exportMatch = /^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (exportMatch && ENV_KEYS.includes(exportMatch[1])) {
      const [value] = tokenize(exportMatch[2]);
      env[exportMatch[1]] = expand(value ?? '', env, home);
      continue;
    }
    // The launch line is the one that runs Appium's main.js (any node binary path); exports are handled above.
    if (!exec && /main\.js/u.test(line)) exec = line.replace(/^exec\s+/u, '');
  }
  if (!exec) throw new Error('Appium launch file has no node entry line');
  const tokens = tokenize(exec).map(token => expand(token, env, home));
  const node = tokens.shift();
  const entryIndex = tokens.findIndex(token => token.endsWith('.js'));
  if (!node || entryIndex === -1) throw new Error('Appium launch file has no node entry script');
  const entry = tokens[entryIndex];
  // Drop shell positional passthroughs ("$@", "$*", "$1"…) and anything that expanded to empty:
  // node is spawned directly, so these would otherwise become bogus literal arguments.
  const args = tokens.filter((token, index) => index !== entryIndex && token !== '' && !/^\$[@*#0-9]+$/u.test(token));
  for (const key of ENV_KEYS) if (!env[key]) throw new Error(`Appium launch file is missing ${key}`);
  if (args.length > 32 || args.some(arg => typeof arg !== 'string' || arg.length > 256)) throw new Error('Appium launch arguments are out of range');
  return {node, entry, args, env: Object.fromEntries(ENV_KEYS.map(key => [key, env[key]]))};
}

/**
 * Resolve the launch descriptor from an explicit file, or the reserved host default
 * ~/.local/share/starvoice/android-toolchain/run-appium.sh. Returns null when nothing is found and none was asked for.
 */
export function resolveAppiumLaunch({file, home = homedir()} = {}) {
  const target = file ?? join(home, DEFAULT_APPIUM_LAUNCH_FILE);
  if (!existsSync(target)) {
    if (file) throw new Error('The given --appium-launch-file does not exist');
    return null;
  }
  return parseAppiumLaunch(readFileSync(target, 'utf8'), {home});
}
