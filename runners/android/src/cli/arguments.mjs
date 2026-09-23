const OPTIONS = new Set(['serial', 'adb-path', 'appium-path', 'appium-cli-path', 'appium-url', 'state-dir', 'cloud-url', 'simulation', 'label', 'evidence-file', 'duration-seconds', 'device-profile']);

export function parseArguments(args) {
  const [command = 'help', ...rest] = args;
  if (!['help', 'doctor', 'demo', 'status', 'deliver', 'retry-delivery', 'run', 'setup', 'start', 'stop', 'close'].includes(command)) {
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
  if (['status', 'deliver', 'retry-delivery', 'setup', 'start', 'stop', 'close'].includes(command) && !values['state-dir']) {
    throw new Error('--state-dir is required');
  }
  if (values.simulation && !['true', 'false'].includes(values.simulation)) throw new Error('Invalid simulation mode');
  if (command === 'setup' && !values.serial) throw new Error('--serial is required');
  if (command === 'close' && !values['evidence-file']) throw new Error('--evidence-file is required');
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
start   --state-dir DIR   Foreground daemon; SIGINT/SIGTERM requests a bounded stop.
stop    --state-dir DIR   Durable stop request; inspect status to confirm closure.
close   --state-dir DIR --evidence-file PATH  Explicit independent device closure proof.
status  --state-dir DIR   Show daemon, device closure and durable outbox state.
demo    --cloud-url http://127.0.0.1:PORT [--duration-seconds 15]
        Opt-in loopback control-plane simulation; never a production tenant.
deliver --state-dir DIR   One bounded delivery attempt to the configured server.
retry-delivery --state-dir DIR  Explicit retry after correcting a blocked delivery.
run                      Reports profile_required until real-device P0 passes.

Delivery requires STARVOICE_CLOUD_URL and STARVOICE_AGENT_TOKEN in the environment.
Never place a token in a command argument or commit it in a configuration file.
`;
