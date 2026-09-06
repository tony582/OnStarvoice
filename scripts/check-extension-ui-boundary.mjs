import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../extension-ui/', import.meta.url));
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.html', '.css']);
const REQUIRED_CSP = {
  'default-src': "'none'",
  'script-src': "'self'",
  'style-src': "'self'",
  'img-src': "'self'",
  'connect-src': "'none'",
  'object-src': "'none'",
  'base-uri': "'none'",
  'form-action': "'none'",
};

function attributes(tag) {
  const result = new Map();
  const duplicates = new Set();
  const pattern = /\s+([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu;
  for (const match of tag.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    // Browsers preserve the first duplicate attribute. Do not let a later value
    // make this source-policy lint approve a different CSP or resource target.
    if (result.has(name)) duplicates.add(name);
    else result.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return { values: result, duplicates };
}

function withoutComments(source) {
  // Preserve offsets and quoted content; imports may legally contain comments
  // between tokens. This is normalization for a lint, not an ECMAScript parser.
  return source.replace(/"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu, match =>
    match.startsWith('//') || match.startsWith('/*') ? match.replace(/[^\r\n]/gu, ' ') : match);
}

/**
 * Conservative source-policy lint, not a JavaScript sandbox or a provenance proof.
 * It scans all source files, not just reachable modules. CSP provides the separate
 * browser network barrier. Computed/obfuscated JavaScript is outside this lint's
 * semantic guarantees and still requires code review and browser acceptance.
 */
export async function checkExtensionUiBoundary({ root = DEFAULT_ROOT, requireUiEntry = false } = {}) {
  let absoluteRoot = path.resolve(root);
  const findings = [];
  const files = [];
  const add = (file, rule, message, source = '', offset = 0) => {
    findings.push({
      file: path.relative(absoluteRoot, file).split(path.sep).join('/') || '.',
      line: source.slice(0, offset).split('\n').length,
      rule,
      message,
    });
  };
  const inside = target => target === absoluteRoot || target.startsWith(`${absoluteRoot}${path.sep}`);

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        add(fullPath, 'symlink', 'UI source must not use symbolic links.');
      } else if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(fullPath);
      }
    }
  }

  try {
    if (!(await lstat(absoluteRoot)).isDirectory()) {
      add(absoluteRoot, 'root', 'UI root must be a real directory, not a symbolic-link path.');
      return { ok: false, files: [], findings, mode: 'core-only', uiEntryPresent: false };
    }
    // Normalize OS aliases such as macOS /var -> /private/var before checking
    // source-relative escapes. The source root itself may not be a symlink.
    absoluteRoot = await realpath(absoluteRoot);
    await visit(absoluteRoot);
  } catch (error) {
    add(absoluteRoot, 'missing-root', `UI source directory is missing or unreadable (${error.code ?? 'error'}).`);
    return { ok: false, files: [], findings, mode: 'core-only', uiEntryPresent: false };
  }

  const uiEntryPresent = ['index.html', 'app.mjs'].every(entry => files.includes(path.join(absoluteRoot, entry)));
  if (files.length === 0) add(absoluteRoot, 'missing-source', 'UI boundary cannot pass without inspectable source files.');
  for (const entry of ['index.html', 'app.mjs']) {
    if (requireUiEntry && !files.includes(path.join(absoluteRoot, entry))) {
      add(path.join(absoluteRoot, entry), 'missing-entry', `Required preview entry is missing: ${entry}.`);
    }
  }

  async function reference(file, value, { source, offset, image = false, module = false } = {}) {
    if (value.startsWith('#') && !module) return;
    if (!/^\.{1,2}\//u.test(value) || /[\\?#%\s]/u.test(value)) {
      add(file, 'local-reference', `Only explicit relative local references are permitted: ${value}.`, source, offset);
      return;
    }
    const target = path.resolve(path.dirname(file), value);
    const permittedIcon = image && target === path.resolve(absoluteRoot, '../images/icon128.png');
    if (!inside(target) && !permittedIcon) {
      add(file, 'outside-ui', `Reference escapes the independent UI source: ${value}.`, source, offset);
      return;
    }
    if (module && !['.mjs', '.js'].includes(path.extname(target))) {
      add(file, 'module-type', `Module reference must name a .mjs or .js file: ${value}.`, source, offset);
      return;
    }
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || (await realpath(target)) !== target) {
        add(file, 'reference-kind', `Reference must resolve to a regular, non-symlink file: ${value}.`, source, offset);
      }
    } catch {
      add(file, 'missing-reference', `Local reference does not exist: ${value}.`, source, offset);
    }
  }

  async function inspectJavaScript(file, source) {
    // Deliberately inspect strings and comments too: capability names must remain
    // out of this presentation tree, including dormant examples and string access.
    const forbidden = [
      ['network-api', /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|WebTransport|RTCPeerConnection)\b/gu],
      ['extension-api', /\bchrome\b|\bbrowser\s*(?:\.|\[)|\bbrowser\s*[,;)]|["']browser["']|\bimportScripts\s*\(/gu],
      ['dynamic-code', /\b(?:eval|Function|Worker|SharedWorker|require)\s*\(|\bserviceWorker\b|\bcreateElement\s*\(\s*['"]script['"]/gu],
      ['remote-reference', /(?:https?|wss?):\/\/|\b(?:chrome|moz)-extension:\/\//gu],
      ['persistent-browser-state', /\b(?:localStorage|sessionStorage|indexedDB)\b/gu],
    ];
    for (const [rule, pattern] of forbidden) {
      for (const match of source.matchAll(pattern)) add(file, rule, `Forbidden UI capability: ${match[0]}.`, source, match.index);
    }

    const relativeFile = path.relative(absoluteRoot, file).split(path.sep).join('/');
    const clipboardCalls = [...source.matchAll(/\bnavigator\s*\.\s*clipboard\s*\.\s*writeText\s*\(\s*sanitizedDiagnostics\s*\)/gu)];
    const clipboardMentions = [...source.matchAll(/\bclipboard\b/gu)];
    if (clipboardMentions.length && (
      relativeFile !== 'preview/clipboard.mjs' || clipboardCalls.length !== clipboardMentions.length
    )) {
      add(file, 'clipboard-boundary', 'Clipboard access is restricted to preview/clipboard.mjs using writeText(sanitizedDiagnostics).');
    }

    const normalized = withoutComments(source);
    const imports = [
      /\bimport\s*(?:(["'])([^"'\r\n]+)\1|[\w$*{},\s]+?\s+from\s*(["'])([^"'\r\n]+)\3)/gu,
      /\bexport\s*(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*(["'])([^"'\r\n]+)\1/gu,
    ];
    for (const pattern of imports) {
      for (const match of normalized.matchAll(pattern)) {
        await reference(file, match[4] ?? match[2], { source, offset: match.index, module: true });
      }
    }
    for (const match of normalized.matchAll(/\bimport\s*\(([^)]*)\)/gu)) {
      const literal = /^\s*(["'])([^"'\r\n]+)\1\s*$/u.exec(match[1]);
      if (!literal) add(file, 'dynamic-import', 'Dynamic imports must have one literal relative module path.', source, match.index);
      else await reference(file, literal[2], { source, offset: match.index, module: true });
    }
  }

  async function inspectHtml(file, source) {
    const policies = [];
    // A tag inside a comment is not browser policy evidence. Preserve positions
    // for findings, including when an unfinished comment consumes the remainder.
    // This narrow normalization is not an HTML parser or a browser acceptance test.
    const activeSource = source.replace(/<!--[\s\S]*?(?:-->|$)/gu,
      comment => comment.replace(/[^\r\n]/gu, ' '));
    const tags = [...activeSource.matchAll(/<([a-z][\w:-]*)\b[^>]*>/giu)];
    let policyOffset = Infinity;
    let firstResourceOffset = Infinity;
    for (const match of tags) {
      const name = match[1].toLowerCase();
      const { values: attrs, duplicates } = attributes(match[0]);
      if (duplicates.size) {
        add(file, 'duplicate-html-attribute', `Duplicate HTML attributes are forbidden: ${[...duplicates].join(', ')}.`, source, match.index);
      }
      if (name === 'meta' && attrs.get('http-equiv')?.toLowerCase() === 'content-security-policy') {
        policies.push(attrs.get('content') ?? '');
        policyOffset = Math.min(policyOffset, match.index);
      }
      if (['script', 'link', 'img', 'iframe', 'object', 'embed'].includes(name)) {
        firstResourceOffset = Math.min(firstResourceOffset, match.index);
      }
      if (['iframe', 'object', 'embed', 'base', 'form'].includes(name)) {
        add(file, 'active-html', `Element is outside the offline preview boundary: ${name}.`, source, match.index);
      }
      if (name === 'meta' && attrs.get('http-equiv')?.toLowerCase() === 'refresh') {
        add(file, 'html-navigation', 'Meta refresh is not permitted in the offline preview.', source, match.index);
      }
      for (const [key, value] of attrs) {
        if (/^on/iu.test(key) || key === 'style' || key === 'srcdoc') {
          add(file, 'inline-html', `Inline active/style attribute is forbidden: ${key}.`, source, match.index);
        }
        if (['srcset', 'ping', 'action', 'formaction'].includes(key)) {
          add(file, 'html-network', `Unreviewed navigation/network attribute: ${key}.`, source, match.index);
        }
        if (['src', 'href', 'poster', 'data'].includes(key)) {
          await reference(file, value, { source, offset: match.index, image: name === 'img' && key === 'src', module: name === 'script' });
        }
      }
      if (name === 'script' && (!attrs.has('src') || attrs.get('type') !== 'module')) {
        add(file, 'inline-script', 'Scripts must be external local modules; inline scripts and import maps are forbidden.', source, match.index);
      }
      if (name === 'style') add(file, 'inline-style', 'Use a local CSS file, not inline style elements.', source, match.index);
    }
    for (const match of activeSource.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/giu)) {
      if (match[1].trim()) add(file, 'inline-script', 'Script elements must not contain inline code.', source, match.index);
    }
    const directives = new Map();
    let duplicate = false;
    for (const piece of (policies[0] ?? '').split(';')) {
      const [key, ...values] = piece.trim().split(/\s+/u);
      if (!key) continue;
      if (directives.has(key)) duplicate = true;
      directives.set(key, values.join(' '));
    }
    if (policies.length !== 1 || duplicate || policyOffset > firstResourceOffset ||
      [...directives.keys()].some(key => !Object.hasOwn(REQUIRED_CSP, key)) ||
      Object.entries(REQUIRED_CSP).some(([key, value]) => directives.get(key) !== value)) {
      add(file, 'preview-csp', 'Place one restrictive CSP before resources; require self-only scripts/styles/images and connect-src none.');
    }
  }

  for (const file of files.sort()) {
    let source;
    try {
      source = await readFile(file, 'utf8');
    } catch (error) {
      add(file, 'unreadable-source', `Cannot inspect source file (${error.code ?? 'error'}).`);
      continue;
    }
    for (const match of source.matchAll(/media[\s_-]*claw|(?:\.\.?\/|\b)(?:sidebar\/|utils\/|background\.js\b|content-(?:v2|loader)\.js\b)/giu)) {
      add(file, 'legacy-reference', `Legacy code/brand reference is outside the new UI boundary: ${match[0]}.`, source, match.index);
    }
    const extension = path.extname(file);
    if (extension === '.html') await inspectHtml(file, source);
    else if (extension === '.js' || extension === '.mjs') await inspectJavaScript(file, source);
    else if (extension === '.css') {
      for (const match of source.matchAll(/url\(\s*(["']?)([^)'"\s]+)\1\s*\)|@import\s*(["'])([^"']+)\3/giu)) {
        await reference(file, match[2] ?? match[4], { source, offset: match.index });
      }
    }
  }
  return {
    ok: findings.length === 0,
    files: files.map(file => path.relative(absoluteRoot, file).split(path.sep).join('/')),
    findings,
    mode: uiEntryPresent ? 'ui-entry' : 'core-only',
    uiEntryPresent,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const result = await checkExtensionUiBoundary({
    root: args.find(argument => argument !== '--require-ui-entry') ?? DEFAULT_ROOT,
    requireUiEntry: args.includes('--require-ui-entry'),
  });
  if (result.ok) console.log(`Extension UI boundary passed (${result.files.length} source files; ${result.mode}${result.uiEntryPresent ? '; offline UI entry checked' : '; UI entry absent, not a completed UI'}).`);
  else {
    for (const finding of result.findings) console.error(`${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`);
    process.exitCode = 1;
  }
}
