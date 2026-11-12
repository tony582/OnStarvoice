const OPTIONS = new Set(['serial', 'adb-path', 'appium-path', 'appium-cli-path', 'appium-url', 'state-dir', 'cloud-url', 'simulation', 'label', 'evidence-file', 'duration-seconds', 'device-profile', 'appium-launch-file', 'hours', 'chrome', 'wechat-preview']);

export function parseArguments(args) {
  const [command = 'help', ...rest] = args;
  if (!['help', 'doctor', 'demo', 'status', 'deliver', 'retry-delivery', 'run', 'setup', 'start', 'stop', 'close', 'up', 'diagnose', 'enable-wechat'].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  const values = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i].slice(2);
    if (!rest[i].startsWith('--') || !OPTIONS.has(name) || !rest[i + 1]
      || rest[i + 1].startsWith('--') || Object.hasOwn(values, name)) {
      throw new Error('Expected a known option followed by one value');
    }
    values[name] = rest[i + 1];
  }
  if (['status', 'deliver', 'retry-delivery', 'setup', 'start', 'stop', 'close', 'up', 'diagnose', 'enable-wechat'].includes(command) && !values['state-dir']) {
    throw new Error('--state-dir is required');
  }
  if (values.simulation && !['true', 'false'].includes(values.simulation)) throw new Error('Invalid simulation mode');
  if (values['wechat-preview'] !== undefined && (!['true', 'false'].includes(values['wechat-preview']) || command !== 'setup')) throw new Error('--wechat-preview true|false is only supported by setup');
  if (command === 'setup' && !values.serial) throw new Error('--serial is required');
  if (command === 'close' && !values['evidence-file']) throw new Error('--evidence-file is required');
  if (values.hours !== undefined && !(Number.isInteger(Number(values.hours)) && Number(values.hours) >= 1 && Number(values.hours) <= 720)) {
    throw new Error('--hours must be 1..720');
  }
  return {command, values};
}

export const HELP = `StarVoice Android Runner — calibrated P0 build

doctor  [--serial SERIAL] [--adb-path PATH] [--appium-path PATH]
        [--appium-cli-path JS_ENTRY] [--appium-url http://127.0.0.1:4723]
        Read-only connection checks; does not install tools or operate Douyin.
demo    [--state-dir DIR]  Run local simulated discovery; no network or device.
setup   --state-dir DIR --serial SERIAL [--cloud-url ORIGIN] [--simulation true]
        [--device-profile douyin-40.6.0-de106-api27-p0] [--adb-path PATH] [--appium-url URL]
        Register with STARVOICE_ACTIVATION_CODE from the environment. Code is not saved.
        [--wechat-preview true] Explicitly install the independent preview browser; does not enable WeChat.
up      --state-dir DIR [--cloud-url ORIGIN] [--serial SERIAL] [--device-profile ID]
        [--adb-path PATH] [--appium-url URL] [--appium-launch-file run-appium.sh]
        One click: adb start-server, start Appium if needed, register on first use
        (prompts for the activation code, which is never saved), then run the daemon.
start   --state-dir DIR   Foreground daemon; SIGINT/SIGTERM requests a bounded stop.
stop    --state-dir DIR   Durable stop request; inspect status to confirm closure.
close   --state-dir DIR --evidence-file PATH  Explicit independent device closure proof.
status  --state-dir DIR   Show daemon, device closure and durable outbox state.
diagnose --state-dir DIR [--hours 24]  Recent keyword runs and why cards or runs ended early (local, read-only).
enable-wechat --state-dir DIR [--chrome PATH]  Also take WeChat Channels tasks on this phone (WeChat 8.0.80):
        installs and verifies an independent Chrome for Testing (python3 >=3.9), builds the local OCR
        helper (swiftc) and records it; the Runner must be stopped. --chrome skips browser installation.
demo    --cloud-url http://127.0.0.1:PORT [--duration-seconds 15]
        Opt-in loopback control-plane simulation; never a production tenant.
deliver --state-dir DIR   One bounded delivery attempt to the configured server.
retry-delivery --state-dir DIR  Explicit retry after correcting a blocked delivery.
run                      Reports profile_required until real-device P0 passes.

Delivery requires STARVOICE_CLOUD_URL and STARVOICE_AGENT_TOKEN in the environment.
Never place a token in a command argument or commit it in a configuration file.
`;
