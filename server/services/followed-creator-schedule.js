// Tenant monitor_runTimes is stored as a comma-separated list in Asia/Shanghai.
export function nextCreatorPatrolTime(value, now = new Date()) {
  const times = String(value ?? '').split(',').map(s => s.trim())
    .filter(s => /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(s)).sort();
  if (!times.length) times.push('10:00');
  const day = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  for (const time of times) {
    const candidate = new Date(`${day}T${time}:00+08:00`);
    if (candidate > now) return candidate;
  }
  return new Date(new Date(`${day}T${times[0]}:00+08:00`).getTime() + 86400000);
}
