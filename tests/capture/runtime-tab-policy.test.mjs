import assert from "node:assert/strict";
import test from "node:test";

await import("../../utils/runtime-tab-policy.js");

const {
  buildCaptureProgressPatch,
  buildRelayRuntimePatch,
  isActiveSenderTab,
  shouldAdoptPageState,
} = globalThis.OnStarvoiceRuntimeTabPolicy;

test("active source progress may adopt runtime ownership", () => {
  const progress = {phase: "list_checkpoint", markedCount: 40};
  assert.equal(isActiveSenderTab({id: 41, active: true}), true);
  assert.deepEqual(buildCaptureProgressPatch({id: 41, active: true}, progress), {
    lastCaptureProgress: progress,
    lastActiveTabId: 41,
  });
});

test("inactive worker progress stays visible without stealing source ownership", () => {
  const progress = {phase: "detail_item_capturing", runnerTabId: 92};
  assert.deepEqual(buildCaptureProgressPatch({id: 92, active: false}, progress), {
    lastCaptureProgress: progress,
  });
});

test("inactive page state and relay cannot replace source runtime context", () => {
  const worker = {id: 92, active: false};
  assert.equal(shouldAdoptPageState(worker), false);
  assert.deepEqual(buildRelayRuntimePatch(worker), {});
});

test("active page state and relay keep the existing positive path", () => {
  const source = {id: 41, active: true};
  assert.equal(shouldAdoptPageState(source), true);
  assert.deepEqual(buildRelayRuntimePatch(source), {lastActiveTabId: 41});
});

test("missing sender tab fails closed", () => {
  assert.equal(isActiveSenderTab(null), false);
  assert.equal(shouldAdoptPageState(undefined), false);
  assert.deepEqual(buildRelayRuntimePatch({id: 0, active: true}), {});
});
