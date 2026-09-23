# Android control plane

This module uses the existing `capture_agents`, `capture_tasks`,
`capture_task_items` and `capture_task_item_attempts`; it does not introduce a
second task queue. Apply migration 087 after discovery-ledger migration 086.
All new routes live at `/api/capture-cloud/android`. The pilot is disabled by
default; `ANDROID_DISCOVERY_INGEST_TENANTS` is an explicit tenant allowlist shared
with candidate intake. Real-phone search still requires a verified device profile.

## Registration and operator API

`POST /register` accepts `{code,clientUuid,deviceId,clientLabel?,appVersion?}`.
The activation code is checked transactionally with its active tenant, expiry and
binding quota. The stable UUID is namespaced `android:`. A live device ID cannot
be registered by a second node in the same tenant. The response contains
`{ok,tenantId,agent:{id,token,deviceId,capabilities}}`; the plaintext token is
returned only here, never by node-list queries. Re-registration rotates tokens.
All new nodes have `agentKind=android_mobile` and legacy browser-dispatch
capabilities disabled. Browser heartbeat and command completion reject mobile
nodes, and the old task stop/resume controls reject mobile workflows.

Operator endpoints require an authenticated backend user and tenant membership.
Writes additionally require the existing tenant-writer permission. Activation
codes are not operator sessions.

| Endpoint | Input / result |
| --- | --- |
| `GET /capabilities` | `{enabled}`; a disabled tenant receives 200 and false |
| `GET /nodes` | `{nodes}`; online/readiness, device hold and active run |
| `GET /runs` | `{runs}`; latest 50 mobile runs only |
| `GET /runs/:id` | `{run,items,candidates,events}`; candidate/event lists bounded at 100 |
| `POST /runs` | `{requestId,agentId,keywords?,title?,filters?,budgets?}`; returns run detail |
| `POST /runs/:id/stop` | `{scope:'discovery'|'batch'}`; returns run detail |
| `POST /runs/:id/resume` | explicit recovery after device closure; returns run detail |

A stable create request ID deduplicates unknown HTTP results; a different payload
under that ID returns 409. There are one or two keywords per pilot run, defaulting
to 别克壁纸 and 君越壁纸. Filters are `{sort:'latest'|'comprehensive',range:'day'}`;
the default is comprehensive ranking with the App's one-day publication filter.
Budgets may decrease but not exceed 20 links, 40 cards, 20 swipes, 10 minutes per
keyword, 25 minutes per batch, and 100 pending events. The absolute deadline starts
on first claim and never moves during recovery, so an offline queued phone does
not consume its run budget before starting.

## Runner API and durable ownership

All `/agent/*` endpoints require the issued bearer token and active original
code/binding/tenant entitlement. Task payloads have the runner's exact identity:
`{discoveryRunId,taskId,itemId,attemptId,assignmentRevision,requestHash,agentId}`.
The first two IDs are equal. Each keyword retains its own item and attempt history.

- `POST /agent/poll {deviceId,sessionId,readyForSearch}` returns
  `{task,permit,control,pollAfterMs:5000,renewAfterMs:30000}`. `task` contains identity,
  deviceId, keyword, filters, budgets, deadlineAt, and resumeAuthorized.
- `POST /agent/renew {identity,sessionId,leaseId}` returns `{permit,control}`.
  Permits contain identity, leaseId, serverTime and leaseUntil; validity is at most
  90 seconds and bounded by the original batch deadline. Renewal keeps the leaseId.
- `POST /agent/complete {requestId,identity,sessionId,status,reason,deviceIdle,checkpoint?}`
  returns `{accepted,deviceHeld}`. Status is completed, interrupted, needs_action,
  or canceled. Replays return the original receipt with duplicate=true; changed
  payloads or request IDs conflict. The original body must be stored durably.
- `POST /agent/close {requestId,identity,evidence}` confirms independent closure.
  Evidence requires method (`operator_takeover` or `independent_stop_check`),
  evidenceId, verifiedBy and verifiedAt after the attempt started. This records an
  external observation; it does not itself inspect a physical phone.

The shared agent execution-slot advisory lock serializes all claims and control
changes. A physical device hold lives in the current item's metadata and survives
server restarts. A stale lease or different runner session returns no permit and
retains the hold. A timeout is never equivalent to a stopped phone. The runner's
host-wide device lock supplies the separate physical-process exclusion.

A stop request immediately fences further renewals; completion with deviceIdle
false cannot release the hold. After explicit closure, resume creates a strictly
newer attempt/revision and keeps the original budgets and deadline. Delayed old
receipts can be acknowledged but cannot overwrite the successor's state.
Canceled runs cannot be resumed. Discovery-only stop leaves existing browser
work to finish; batch stop delegates demand cancellation and downstream stop
fencing to `capture-discovery/detail-lifecycle.js`, preserving shared demands.

Before sending a normal completion, the runner must flush that attempt's candidate
events while its lease/task is still live. Completed or stopped attempts' later
events are audit-only. A database outage causes retry/backoff, not new UI activity
or a new task identity. Readiness reflects the last 120 seconds of heartbeat and
is distinct from the physical hold.

## Module ownership and verification

`validation` owns bounds; `registration` owns entitlement/binding; `repository`
owns shared locks and state aggregation; `tasks` owns operator transitions;
`leases` owns claiming and permits; `completion` owns final receipts and closure;
`views` owns bounded projections; `service` composes them. The router only handles
HTTP, identity, feature flags and error mapping.

Tests: `tests/android-control-route.test.mjs` and
`tests/integration/postgres/android-control.integration.mjs`. The latter requires
an explicitly isolated PostgreSQL test database and validates real transactions,
concurrent claims/quota allocation, old browser-protocol rejection with a real
token, lease expiry, stop confirmation, explicit resume, historical completion
fences, and the actual discovery-ingest lineage contract. It is not device QA.
