import assert from "node:assert/strict";
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import * as prototype from "../../prototypes/extension-sync-confirmation/contract.mjs";

// UNWIRED contract tests only. These assertions do not describe shipping runtime,
// durable recovery, server idempotency, CAS, or permission to replay a request.
const {confirmSyncOperations} = prototype;
const root = fileURLToPath(new URL("../../", import.meta.url));
const copy = (value) => structuredClone(value);

function operation(operationId, {
  recordId = operationId, stage = "content", remoteState = "acknowledged_success",
  remoteResult = remoteState === "not_sent" ? null : {ackId: `ack-${operationId}`, data: {label: operationId}},
} = {}) {
  return {operationId, recordId, stage, remoteState, remoteResult};
}

test("the confirmation prototype has one public entrypoint and is absent from every shipping source root", () => {
  assert.deepEqual(Object.keys(prototype), ["confirmSyncOperations"]);
  const buildScript = readFileSync(join(root, "scripts/sync-extension-build.zsh"), "utf8");
  assert.match(buildScript, /for source_file in manifest\.json background\.js content-loader\.js content-v2\.js;/);
  assert.match(buildScript, /for source_dir in images sidebar utils;/);
  assert.doesNotMatch(buildScript, /extension-sync-confirmation|confirmSyncOperations|prototypes/);
  const checked = [];
  function inspect(relative) {
    const full = join(root, relative);
    if (statSync(full).isDirectory()) {
      for (const entry of readdirSync(full)) inspect(join(relative, entry));
    } else if (/\.(?:js|mjs|html|json|css)$/i.test(relative)) {
      const content = readFileSync(full, "utf8");
      assert.doesNotMatch(content, /extension-sync-confirmation|confirmSyncOperations/, relative);
      checked.push(relative);
    }
  }
  for (const source of ["manifest.json", "background.js", "content-loader.js", "content-v2.js", "images", "sidebar", "utils"]) inspect(source);
  assert.ok(checked.includes(join("utils", "capture-sync.js")));
  assert.ok(checked.includes(join("utils", "storage.js")));
  assert.ok(checked.includes(join("sidebar", "sidebar-logic.js")));
});

test("confirmed success and confirmed remote failure remain distinct operations rather than an overall ok flag", async () => {
  const operations = [operation("success"), operation("failure", {remoteState: "acknowledged_failure", remoteResult: {reason: "invalid_request"}}),
    operation("later", {remoteState: "not_sent"})];
  const seen = [];
  const result = await confirmSyncOperations({operations, commit: async (input) => {seen.push(input); return true;}});
  assert.deepEqual(seen, operations.slice(0, 2));
  assert.notEqual(seen[0], operations[0]);
  assert.notEqual(seen[0].remoteResult, operations[0].remoteResult);
  assert.equal(Object.hasOwn(seen[0], "localState"), false);
  assert.deepEqual(result.operations.map(({localState}) => localState), ["confirmed", "confirmed", "not_attempted"]);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.stoppedAtOperationId, null);
  assert.equal(result.requiresReconciliation, false);
  assert.equal(result.blockAutomaticReplay, false);
  assert.equal(Object.hasOwn(result, "ok"), false);
  assert.equal(Object.hasOwn(result, "syncPaused"), false);
  assert.deepEqual(result.totals, {operationCount: 3, remoteSuccessCount: 1, remoteFailureCount: 1,
    remoteUnknownCount: 0, notSentCount: 1, localConfirmedCount: 2,
    localUnconfirmedCount: 0, localNotAttemptedCount: 1});
});

test("a single request's five ACKs survive B's false commit while F remains explicitly not sent", async () => {
  const operations = ["a", "b", "c", "d", "e"].map((id) => operation(id));
  operations.push(operation("f", {remoteState: "not_sent"}));
  const before = copy(operations);
  const committed = [];
  const result = await confirmSyncOperations({operations, commit: async ({operationId}) => {
    committed.push(operationId);
    return operationId !== "b";
  }});
  assert.deepEqual(committed, ["a", "b"]);
  assert.equal(result.stoppedAtOperationId, "b");
  assert.equal(result.requiresReconciliation, true);
  assert.equal(result.blockAutomaticReplay, true);
  assert.deepEqual(result.operations.map(({localState}) => localState), ["confirmed", "unconfirmed", "not_attempted", "not_attempted", "not_attempted", "not_attempted"]);
  assert.deepEqual(result.operations.map(({remoteState}) => remoteState), [...Array(5).fill("acknowledged_success"), "not_sent"]);
  assert.deepEqual(result.operations.map(({remoteResult}) => remoteResult), before.map(({remoteResult}) => remoteResult));
  assert.equal(result.operations[1].localError.code, "LOCAL_COMMIT_NOT_CONFIRMED");
  assert.equal(result.operations[2].localError, null, "an unattempted local write is not a failed write");
  assert.deepEqual(result.totals, {operationCount: 6, remoteSuccessCount: 5, remoteFailureCount: 0,
    remoteUnknownCount: 0, notSentCount: 1, localConfirmedCount: 1,
    localUnconfirmedCount: 1, localNotAttemptedCount: 4});
  assert.deepEqual(operations, before);
});

test("prior-group confirmation survives a current-group exception and a later group stays not sent", async () => {
  const operations = [operation("prior-group"), operation("current-group"), operation("later-group", {remoteState: "not_sent"})];
  const calls = [];
  const result = await confirmSyncOperations({operations, commit: async ({operationId}) => {
    calls.push(operationId);
    if (operationId === "current-group") throw new Error("injected storage failure");
    return true;
  }});
  assert.deepEqual(calls, ["prior-group", "current-group"]);
  assert.equal(result.operations[0].localState, "confirmed");
  assert.equal(result.operations[1].localState, "unconfirmed");
  assert.deepEqual(result.operations[1].localError, {code: "LOCAL_COMMIT_EXCEPTION", message: "injected storage failure"});
  assert.equal(result.operations[2].remoteState, "not_sent");
  assert.equal(result.operations[2].localState, "not_attempted");
  assert.equal(result.operations[1].remoteResult.ackId, "ack-current-group");
  assert.equal(result.totals.localConfirmedCount, 1);
  assert.equal(result.stoppedAtOperationId, "current-group");
});

test("content and comment-leads confirmation remain separate even for the same record", async () => {
  const content = operation("record-content", {recordId: "same-record"});
  const leads = operation("record-leads", {recordId: "same-record", stage: "comment_leads"});
  const result = await confirmSyncOperations({operations: [content, leads], commit: async ({stage}) => stage === "content"});
  assert.equal(result.operations.length, 2);
  assert.equal(result.operations[0].localState, "confirmed");
  assert.equal(result.operations[1].localState, "unconfirmed");
  assert.equal(result.operations[0].remoteResult.ackId, "ack-record-content");
  assert.equal(result.operations[1].remoteResult.ackId, "ack-record-leads");
  assert.equal(result.totals.remoteSuccessCount, 2);
  assert.equal(result.totals.localConfirmedCount, 1);
  assert.equal(result.stoppedAtOperationId, "record-leads");
  const remoteFailedLeads = operation("record-leads-failed", {recordId: "same-record", stage: "comment_leads",
    remoteState: "acknowledged_failure", remoteResult: {reason: "rejected_leads"}});
  const partial = await confirmSyncOperations({operations: [content, remoteFailedLeads], commit: async () => true});
  assert.equal(partial.operations[0].remoteState, "acknowledged_success");
  assert.equal(partial.operations[1].remoteState, "acknowledged_failure");
  assert.equal(partial.totals.remoteSuccessCount, 1);
  assert.equal(partial.totals.remoteFailureCount, 1);
  assert.equal(partial.totals.localConfirmedCount, 2);
  assert.equal(partial.requiresReconciliation, false);
});

test("unknown evidence is never committed and requires reconciliation, while not-sent alone does not", async () => {
  const operations = [operation("unknown", {remoteState: "unknown", remoteResult: {reason: "timeout"}}),
    operation("not-sent", {remoteState: "not_sent"}), operation("known")];
  const calls = [];
  const result = await confirmSyncOperations({operations, commit: async ({operationId}) => {calls.push(operationId); return true;}});
  assert.deepEqual(calls, ["known"]);
  assert.equal(result.operations[0].localState, "not_attempted");
  assert.equal(result.operations[1].localState, "not_attempted");
  assert.equal(result.stoppedAtOperationId, null);
  assert.equal(result.requiresReconciliation, true);
  assert.equal(result.blockAutomaticReplay, true);
  assert.equal(result.totals.remoteUnknownCount, 1);
  for (const pending of [[], [operation("later", {remoteState: "not_sent"})]]) {
    const isolated = await confirmSyncOperations({operations: pending, commit: () => assert.fail("nothing acknowledged")});
    assert.equal(isolated.requiresReconciliation, false);
    assert.equal(isolated.blockAutomaticReplay, false); // Not replay authorization.
    assert.equal(isolated.totals.localConfirmedCount, 0);
  }
});

test("only strict true confirms, and every other commit return stops later commits", async () => {
  for (const returned of [false, undefined, null, 0, 1, "true", {}, {ok: true}]) {
    const calls = [];
    const result = await confirmSyncOperations({operations: [operation("a"), operation("b")], commit: async ({operationId}) => {
      calls.push(operationId); return returned;
    }});
    assert.deepEqual(calls, ["a"]);
    assert.equal(result.operations[0].localState, "unconfirmed");
    assert.equal(result.operations[0].localError.code, "LOCAL_COMMIT_NOT_CONFIRMED");
    assert.equal(result.operations[1].localState, "not_attempted");
    assert.equal(result.totals.remoteSuccessCount, 2);
  }
});

test("the entire input is snapshotted before the first pending commit and adapters cannot mutate retained evidence", async () => {
  const operations = [operation("a"), operation("b")];
  const original = copy(operations);
  let entered;
  const started = new Promise((resolve) => {entered = resolve;});
  let release;
  const pending = new Promise((resolve) => {release = resolve;});
  const calls = [];
  let completed = false;
  const running = confirmSyncOperations({operations, commit: async (input) => {
    calls.push(copy(input));
    input.remoteResult.data.label = "adapter mutation";
    if (input.operationId === "a") {entered(); await pending;}
    return true;
  }}).then((result) => {completed = true; return result;});
  await started;
  assert.equal(completed, false);
  assert.equal(calls.length, 1, "later commit cannot start while the first is pending");
  assert.deepEqual(operations, original, "adapter received an independent copy");
  operations[1].remoteResult.data.label = "caller mutation while pending";
  operations.push(operation("too-late"));
  release();
  const result = await running;
  assert.deepEqual(calls, original);
  assert.equal(result.operations.length, 2);
  assert.deepEqual(result.operations.map(({remoteResult}) => remoteResult), original.map(({remoteResult}) => remoteResult));
  result.operations[0].remoteResult.data.label = "consumer mutation";
  assert.equal(operations[0].remoteResult.data.label, "a");
});

test("malformed or unclonable later operations are rejected before any earlier commit", async () => {
  const valid = operation("first");
  const invalidOperations = [
    null, [], "legacy", {}, operation(""), operation(" padded "), operation("second", {recordId: ""}),
    operation("second", {recordId: " padded "}), operation("second", {stage: "other"}),
    operation("second", {remoteState: "success"}), operation("second", {remoteResult: null}),
    operation("second", {remoteState: "acknowledged_failure", remoteResult: null}),
    operation("second", {remoteResult: []}), operation("second", {remoteResult: "ack"}),
    operation("second", {remoteResult: {callback: () => true}}),
    operation("second", {remoteState: "not_sent", remoteResult: {ackId: "impossible"}}),
    operation("first"),
  ];
  for (const invalid of invalidOperations) {
    let commits = 0;
    await assert.rejects(confirmSyncOperations({operations: [valid, invalid], commit: () => {commits += 1; return true;}}), TypeError);
    assert.equal(commits, 0);
  }
  for (const operations of [undefined, null, {}, "legacy"]) {
    await assert.rejects(confirmSyncOperations({operations, commit: () => assert.fail("invalid operations")}), TypeError);
  }
  for (const commit of [undefined, null, {}, true]) {
    await assert.rejects(confirmSyncOperations({operations: [valid], commit}), TypeError);
  }
});

test("unusual commit exceptions cannot erase captured remote evidence", async () => {
  const poisonous = Object.defineProperty({}, "message", {get() {throw new Error("message getter failed");}});
  for (const thrown of [null, "plain failure", poisonous, new Error("x".repeat(700))]) {
    const inputs = [operation("a"), operation("b")];
    const before = copy(inputs);
    const result = await confirmSyncOperations({operations: inputs, commit: async () => {throw thrown;}});
    assert.equal(result.operations[0].localError.code, "LOCAL_COMMIT_EXCEPTION");
    assert.ok(result.operations[0].localError.message.length > 0);
    assert.ok(result.operations[0].localError.message.length <= 512);
    assert.equal(result.operations[1].localState, "not_attempted");
    assert.deepEqual(result.operations.map(({remoteResult}) => remoteResult), before.map(({remoteResult}) => remoteResult));
    assert.deepEqual(inputs, before);
  }
});
