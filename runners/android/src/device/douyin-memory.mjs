// Memory pressure on the phone (2026-10-08). Douyin had been running for eight days, had grown to 2.7 GB resident
// with another 1.5 GB in swap, and the swap partition was full (4 kB free). Every screen read then took 3–11 s, and
// any read over the 10 s bound ended the keyword as device_timeout, round after round, with nothing in the logs
// but the slowness itself. The launch path never restarts Douyin, so the Runner now reads /proc/meminfo before it
// claims a keyword and, under pressure, stops Douyin once and starts it again (douyin-foreground.mjs).
const FIELD = /^(\w+):\s+(\d+)\s*kB/u;

/** `cat /proc/meminfo`: the fields the decision uses, in kB; null for a field the phone does not print. */
export function parseMemInfo(text = '') {
  const fields = {};
  for (const line of String(text).split(/\r?\n/u)) {
    const match = FIELD.exec(line.trim());
    if (match && !(match[1] in fields)) fields[match[1]] = Number(match[2]);
  }
  const pick = key => Number.isFinite(fields[key]) ? fields[key] : null;
  return {memTotalKb: pick('MemTotal'), memAvailableKb: pick('MemAvailable'), swapTotalKb: pick('SwapTotal'), swapFreeKb: pick('SwapFree')};
}

/** Restart Douyin when less than this is available, or when less than this share of the swap partition is free. */
export const MEMORY_RESTART_THRESHOLDS = Object.freeze({memAvailableKb: 1_048_576, swapFreeRatio: 0.1});

const known = value => typeof value === 'number' && Number.isFinite(value);

/**
 * One reading, one decision. A field the phone does not print never counts as pressure: a phone without swap is
 * judged by MemAvailable alone, and a reading with neither field is never a reason to restart anything.
 */
export function memoryPressure(reading, thresholds = MEMORY_RESTART_THRESHOLDS) {
  const reasons = [];
  if (known(reading?.memAvailableKb) && reading.memAvailableKb < thresholds.memAvailableKb) reasons.push('mem_available_low');
  if (known(reading?.swapTotalKb) && reading.swapTotalKb > 0 && known(reading.swapFreeKb)
      && reading.swapFreeKb < reading.swapTotalKb * thresholds.swapFreeRatio) reasons.push('swap_exhausted');
  return {starved: reasons.length > 0, reasons};
}

const gb = kb => `${(kb / 1_048_576).toFixed(1)} GB`;
const mb = kb => `${Math.round(kb / 1024)} MB`;

/** "可用 1.4 GB · 交换区剩 0 MB / 2.5 GB", for the one-click window and the diagnose output. */
export function describeMemory(reading) {
  const parts = [];
  if (known(reading?.memAvailableKb)) parts.push(`可用 ${gb(reading.memAvailableKb)}`);
  if (known(reading?.swapTotalKb) && reading.swapTotalKb > 0) {
    parts.push(`交换区剩 ${known(reading.swapFreeKb) ? mb(reading.swapFreeKb) : '未知'} / ${gb(reading.swapTotalKb)}`);
  }
  return parts.join(' · ') || '内存读数未知';
}
