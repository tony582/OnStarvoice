# Android Runner core

This is a device-independent execution core, not a working Douyin selector profile.
Node.js 24 or newer is required **only for this standalone runner**, because its local
durable store uses `node:sqlite`. The production server runtime is unchanged.

## Entry points

- `runDiscoveryTask` in `discovery-runner.mjs`: runs **one keyword item**.
- `ExecutionPermit` in `execution-permit.mjs`: bounded, monotonic execution permission
  plus an irreversible local stop signal.
- `RunnerStore` in `../storage/runner-store.mjs`: SQLite outbox, receipts and versioned
  checkpoints. Database permissions are restricted to the current user.

Two keywords use two separately assigned items and two permit instances, with the
same `discoveryRunId` and store. The caller serializes execution and holds the physical
device lock from `device-lock.mjs`. SQLite checkpoint compare-and-swap detects
concurrent state writes; it does not replace that lock or the cloud execution slot.

```js
const task = {
  identity: {
    discoveryRunId: 'run-id', taskId: 'run-id', itemId: 'keyword-item-id',
    attemptId: 'attempt-id', assignmentRevision: 1,
    requestHash: 'immutable-request-hash', agentId: 'phone-agent-id',
  },
  deviceId: 'explicit-adb-serial', keyword: '别克壁纸',
  filters: { sort: 'latest', range: 'day' },
  deadlineAt: '2026-09-22T03:00:00Z',
};
```

Optional budgets are positive integers: `maxLinks` (20), `maxCards` (40),
`maxSwipes` (20), `keywordMs` (600000), `batchMs` (1500000), `maxPending` (100).
All items in a discovery run retain the same budget definition. Limits, elapsed
time, spent cards/swipes, distinct work IDs and the earliest absolute deadline
survive restarts. Offline time counts against budgets. Backward wall-clock movement
blocks execution, rather than restoring time. An existing interrupted/needs-action
item requires `resumeAuthorized: true`, a new attempt ID and a strictly newer
assignment revision after the caller verifies current cloud ownership.
Completed/canceled items cannot resume. The caller never changes the
original identity on old outbox events.

Recovery also reconciles distinct verified work IDs from immutable outbox events
across **all original attempts for the same run and item**. A crash after event
persistence but before updating the budget cannot create an extra discovery allowance.
Acknowledgement or rejection of an upload does not refund work already discovered.

## Permit and stop

`new ExecutionPermit({identity, monotonicNow})` starts without permission. After an
authenticated cloud response, call `grant({...identity, leaseId, serverTime,
leaseUntil}, {requestStartedAt})`. Times in the response are ISO strings; request
start is a local monotonic value recorded before the network request. A grant cannot
exceed 90 seconds. Late, wrong-attempt and expired responses are rejected.

`permit.stop('user_stop' | 'remote_stop' | 'operator_takeover')` aborts the active
device operation and prohibits subsequent actions. The core bounds each command to
10 seconds by default (maximum 15) and the remaining lease, whichever expires first.
If cancellation/timeout leaves physical completion uncertain, the result has
`deviceIdle: false` and `stopConfirmationRequired: true`. Even a later settled promise
does not silently clear that uncertainty. The caller must preserve the device lock
until independent stop evidence or explicit operator takeover. `deviceIdle: true`
means this invocation has no outstanding command; it is not phone-screen inspection.

`DeviceClosureJournal` writes `device-closure:<deviceId>` before each command is
handed to the adapter. Only a confirmed normal completion (or an explicitly retry-safe
loading failure) clears the marker. A timeout, cancellation, or process crash leaves
it pending; **new runs as well as resumed runs** on the same device are blocked before
the first inspection. `resumeAuthorized` alone never bypasses this guard.

After independently confirming physical closure, the caller may supply
`deviceClosureVerified: {deviceId, operationId, method, evidenceId, verifiedBy,
verifiedAt}`. `operationId` must match the pending marker; `method` is
`operator_takeover` or `independent_stop_check`; the ISO verification time must fall
between the operation start and the current time. A bare boolean is not evidence.
The latest explicit proof is retained across later commands. This input records
external verification; the runner cannot itself prove a human inspected the phone.

## Physical device lock

`acquireDeviceLock({lockRoot, serial, ownerId?})` atomically creates a serial-hashed
lock directory and returns `{path, token, owner, release}`. Choose **one stable
host-wide lockRoot**, independent of task, state-file location and process. Different
serials can have independent locks. Lock acquisition must precede real-device use.
This helper is not wired into a real-phone run command: that entry point and daemon
are not implemented yet. Their future integration must hold this host-wide lock
around all device control. The core function alone does not provide process exclusion.

`inspectDeviceLock({lockRoot,serial})` reads ownership without changing it.
`releaseDeviceLock({lockRoot,serial,token})` (or the returned `release()`) checks the
current owner token before removal. A previous owner's release cannot remove a new
owner's lock. A dead PID, old timestamp, malformed metadata or incomplete directory
never authorizes automatic takeover or deletion. PID is diagnostic only.

Release only after the caller has confirmed command closure. If a process exits or
`stopConfirmationRequired` is true, keep the lock for explicit operator recovery;
do not put an unconditional release in `finally`. Any recovery of an orphaned lock
must preserve the closure evidence and check the current ownership token. The local
demo uses a synthetic device and need not acquire a real-phone lock.

## Device evidence contract

Every device method receives an `AbortSignal` and must observe it. Required methods:

| Method | Required evidence |
| --- | --- |
| `inspect` | Exact `deviceId`, `connected/unlocked/loggedIn=true`, `challenge=false`; `readyForSearch=false` blocks with its explicit reason |
| `search` | `verified=true`, exact `keyword/filters`, nonempty `contextId` |
| `readCards` | `contextVerified=true`, same context, cards with nonempty `cardId`, explicit `end` when observed |
| `openCard` | `identityVerified=true`, matching `cardId`, nonempty `detailId`; optionally independently verified `externalId` |
| `copyLink` | Receives a fresh clipboard marker; returns `fresh/markerReplaced/identityVerified=true`, matching detail, work `externalId`, `shareUrl` |
| `returnToResults` | Same verified keyword, filters and context |
| `scroll` | Verified matching context |

IDs must represent observed identity, not guessed title/OCR/position equivalence.
For direct work URLs the ID in the URL must match. A short URL also needs a verified
work ID from the adapter; a fresh clipboard string alone is insufficient. Unverified
links persist an audit event and stop the workflow. Profile-less real adapters are
expected to return `profile_required`; tests never advertise them as phone support.
Only errors explicitly marked `code='loading_failed', safeToRetry=true` in search
or card reads receive one retry. Other actions are not blindly replayed.

## Outbox API

- `recordEvent(payload)` persists immutable JSON with `eventId`; same ID plus different
  payload throws `event_payload_conflict`. Generated event IDs bind original item,
  attempt and verified work identity. Timestamps are preserved on replay.
- `nextBatch({limit: 5})` returns `{uploadBatchId, events}` or null. An open batch
  always returns its original ID, membership, order and payloads after restart,
  including members whose individual receipts have already arrived.
- `ackBatch(id, receipts)` accepts `accepted`, `duplicate`, or `rejected` receipts;
  accepted/duplicate require a durable `receiptId`. Membership validation and updates
  are transactional. Rejections stay quarantined with their evidence; no automatic
  retargeting or deletion occurs.
- `pendingCount()`, `quarantinedCount()`, `getEvent(id)` expose current local state.
- `discoveredWorkIds({discoveryRunId,itemId})` reads distinct verified work IDs across
  original attempts and delivery states for recovery accounting.
- `loadCheckpoint(key)` returns null or `{revision,value}`;
  `saveCheckpoint(key,value,expectedRevision=0)` advances a CAS revision. Core budget
  keys are the `discoveryRunId`; closure keys start with `device-closure:`.
  Transport/control checkpoints need separate prefixes.

The core does not implement HTTP, backoff, cloud authorization, candidate creation
or browser detail collection. Transport failure only replays the outbox; it must
never rerun UI actions to regenerate a missing acknowledgement.

## Verification

Run `node --test runners/android/test/core*.test.mjs` from the repository root on
Node 24+. The tests use explicit synthetic device evidence and real temporary SQLite
files for restart checks. They cover budget preservation, receipt/payload conflicts,
monotonic permission, uncertain cancellation, filtering and clipboard identity errors.
Crash tests include an actual subprocess exit during a device action; filesystem
tests prove orphaned locks remain held and old owner tokens cannot release successors.
They do not prove real-phone search coverage or Douyin UI compatibility.
