import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {Writable} from 'node:stream';
import {AndroidDaemon} from '../daemon/runtime.mjs';
import {readConfig} from '../daemon/state.mjs';
import {setupRunner} from '../daemon/setup.mjs';
import {resolveAppiumLaunch} from '../daemon/appium-launch.mjs';
import {ensureAppium, stopAppium, wait} from '../daemon/appium-process.mjs';
import {createAdbClient} from '../device/adb.mjs';
import {DOUYIN_P0_PROFILE} from '../device/douyin-profile.mjs';

// Plain-language readiness reasons, matching the admin node rail wording.
const REASON_TEXT = Object.freeze({
  douyin_not_foreground: '抖音未在前台', device_locked: '需解锁手机', device_asleep: '手机息屏',
  device_missing: '手机未连接', appium_not_ready: 'Appium 执行器未就绪', profile_required: '未配置采集组合',
  login_required: '需登录抖音', login_or_challenge_required: '需登录抖音', challenge_or_unknown: '需在手机上处理验证',
  profile_version_mismatch: '机型或抖音版本不匹配', device_closure_required: '需人工确认手机停稳',
});

/** One human-readable status line from the daemon's current probe. */
export function describeReadiness(daemon) {
  if (daemon.ready) return '手机已连接 · 抖音在前台 · 已上线，可在调度中心下发任务';
  const reason = daemon.blocked ?? daemon.deviceReason ?? 'profile_required';
  return `${REASON_TEXT[reason] ?? reason} · 等待…`;
}

async function watchReadiness(daemon, {stdout, sleep, signal, watchMs}) {
  let last;
  while (!signal.aborted) {
    const line = describeReadiness(daemon);
    if (line !== last) { stdout(line); last = line; }
    await sleep(watchMs, signal);
  }
}

// TTY prompt. The activation code is read with echo suppressed and is never written to disk or logs.
function defaultPrompt(input = process.stdin, output = process.stdout) {
  return ({question, secret = false}) => new Promise(resolve => {
    let masking = false;
    const mux = new Writable({write(chunk, _enc, cb) { if (!(masking && secret)) output.write(chunk); cb(); }});
    const rl = createInterface({input, output: mux, terminal: true});
    rl.question(question, answer => { rl.close(); if (secret) output.write('\n'); resolve(answer); });
    masking = true;
  });
}

function defaultOnSignals(stop) {
  const handler = () => stop();
  const names = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const name of names) process.once(name, handler);
  return () => { for (const name of names) process.removeListener(name, handler); };
}

async function firstRunSetup({stateDir, values, env, stdout, adb, setup, prompt}) {
  const fallbackCloud = values['cloud-url'] ?? env.STARVOICE_CLOUD_URL ?? '';
  const cloudAnswer = (await prompt({question: `调度中心地址${fallbackCloud ? ` [${fallbackCloud}]` : ''}: `})).trim();
  const baseUrl = cloudAnswer || fallbackCloud;
  if (!baseUrl) throw new Error('需要调度中心地址');
  const code = (await prompt({question: '激活码（输入不显示）: ', secret: true})).trim();
  if (!code) throw new Error('需要激活码');
  let serial = values.serial;
  if (!serial) {
    const listed = await adb.listDevices();
    const online = listed.filter(device => device.state === 'device');
    if (online.length !== 1) {
      stdout('未能唯一确定设备，请用 --serial 指定其中之一：');
      for (const device of listed) stdout(`  ${device.serial}\t${device.state}`);
      throw new Error('adb 未列出唯一在线设备');
    }
    serial = online[0].serial;
    stdout(`已自动选择设备 ${serial}`);
  }
  await setup({stateDir, baseUrl, deviceId: serial, code,
    deviceProfile: values['device-profile'] ?? DOUYIN_P0_PROFILE.id,
    adbPath: values['adb-path'], appiumUrl: values['appium-url'],
    appiumLaunchFile: values['appium-launch-file'], clientLabel: values.label ?? 'StarVoice 手机采集'});
  stdout('注册完成，凭证已写入状态目录（激活码不落盘）');
}

/**
 * One-click launcher: ensure the adb server, start Appium when it is not already serving /status, register on
 * first use, run the daemon in-process, print readiness changes, and on a signal stop the daemon then Appium.
 */
export async function runUp(values, {env = process.env, stdout = console.log, deps = {}} = {}) {
  const {ensureAppium: ensureAppiumDep = ensureAppium, stopAppium: stopAppiumDep = stopAppium,
    createDaemon = options => new AndroidDaemon(options), setup = setupRunner, resolveLaunch = resolveAppiumLaunch,
    prompt = defaultPrompt(), sleep = wait, onSignals = defaultOnSignals, watchMs = 500} = deps;
  const stateDir = resolve(values['state-dir']);
  const adb = deps.adb ?? createAdbClient({adbPath: values['adb-path']});
  await adb.startServer();
  if (!existsSync(join(stateDir, 'connection.json'))) await firstRunSetup({stateDir, values, env, stdout, adb, setup, prompt});
  const config = readConfig(stateDir);
  let appiumChild = null;
  if (!config.simulation && config.deviceProfile) {
    const launch = config.appiumLaunch ?? resolveLaunch({file: values['appium-launch-file']});
    const {started, child} = await ensureAppiumDep({appiumUrl: config.appiumUrl, launch, onLog: () => {}});
    appiumChild = child;
    stdout(started ? 'Appium 执行器已由启动器拉起' : 'Appium 执行器已在运行');
  }
  const daemon = createDaemon({stateDir, config, actionTimeoutMs: config.deviceProfile ? 60000 : 10000});
  const cleanup = onSignals(() => daemon.requestStop('user_stop'));
  const watch = new AbortController();
  const watcher = watchReadiness(daemon, {stdout, sleep, signal: watch.signal, watchMs});
  let final;
  try {
    stdout(`启动器就绪 · 状态目录 ${stateDir} · 设备 ${config.deviceId}`);
    final = await daemon.run();
  } finally {
    watch.abort();
    await watcher.catch(() => {});
    cleanup();
    if (appiumChild) await stopAppiumDep(appiumChild);
  }
  stdout(final?.deviceClosureRequired ? '已停止 · 需人工确认手机停稳（deviceClosureRequired=true）'
    : '已停止 · 手机已释放（deviceClosureRequired=false）');
  return final;
}
