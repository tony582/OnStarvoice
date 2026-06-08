export const SHARED_CAPTURE_POLICY = Object.freeze({
  scrollDelayMinMs: 1000,
  scrollDelayMaxMs: 3000,
  stallTimeoutMs: 3000,
  maxScrollTimes: 50,
  maxDurationMs: 10 * 60 * 1000,
  detailNavTimeoutMs: 90000,
  detailAfterNavWaitMs: 2000,
  profileAfterNavWaitMs: 2000,
});

export function getSharedCapturePolicy(overrides = {}) {
  return {
    ...SHARED_CAPTURE_POLICY,
    ...(overrides && typeof overrides === "object" ? overrides : {}),
  };
}
