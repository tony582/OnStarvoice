import {execFile} from 'node:child_process';
import {existsSync, mkdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {RunnerStore} from '../storage/runner-store.mjs';
import {readConfig, stateValue, writePrivateJson} from '../daemon/state.mjs';
import {WECHAT_PROFILE} from '../device/wechat-profile.mjs';
import {preparePreviewChrome} from '../preview/chrome-install.mjs';

const run = promisify(execFile);
const OCR_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'ocr', 'StarVoiceOCR.swift');

/** Compile the local OCR helper into the state directory (Xcode command line tools' swiftc). */
export async function buildOcrHelper(stateDir, {swiftc = 'swiftc'} = {}) {
  const target = join(resolve(stateDir), 'bin', 'starvoice-ocr');
  mkdirSync(dirname(target), {recursive: true, mode: 0o700});
  await run(swiftc, ['-O', OCR_SOURCE, '-o', target], {timeout: 300_000});
  const {stdout} = await run(target, ['--version'], {timeout: 10_000});
  if (!/^starvoice-ocr \d+/u.test(stdout.trim())) throw new Error('OCR helper did not start');
  return target;
}

/**
 * `enable-wechat --state-dir DIR [--chrome PATH]`: let this phone take WeChat Channels tasks as well. The Runner
 * must be stopped with nothing queued; the Douyin settings are left as they are.
 */
export async function enableWechat({stateDir, chromePath, build = buildOcrHelper, prepareBrowser = preparePreviewChrome,
  onWarning = console.error, onProgress = () => {}}) {
  const directory = resolve(stateDir);
  const config = readConfig(directory);
  const store = new RunnerStore(join(directory, 'runner.sqlite'));
  try {
    if (stateValue(store, 'daemon:active') || stateValue(store, 'daemon:completion') || stateValue(store, 'daemon:status')?.running) {
      throw new Error('Stop the Runner before changing its apps');
    }
  } finally { store.close(); }
  const browser = await prepareBrowser({chromePath, onWarning, onProgress});
  const ocrHelper = await build(directory);
  // Automatic selection stays automatic, including managed CfT and fallbacks.
  // Only a user-supplied override is pinned in connection.json.
  const wechat = {profile: WECHAT_PROFILE.id, ocrHelper,
    ...(chromePath ? {chromePath: browser.path, chromeExplicit: true} : {})};
  writePrivateJson(directory, 'connection.json', {...config, wechat});
  return {ok: true, profile: WECHAT_PROFILE.id, ocrHelper, chrome: browser.path,
    previewBrowser: browser, ocrSourceFound: existsSync(OCR_SOURCE)};
}
