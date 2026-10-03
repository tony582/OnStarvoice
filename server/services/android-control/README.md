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
  deviceId, keyword, filters, budgets, deadlineAt, resumeAuthorized and
  `relevancePrefilter:{enabled}` (see "Card prefilter").
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

### Card prefilter

Opening a result card costs the phone about 17 seconds and most cards of an
ambiguous keyword are noise, so the phone can ask the server's existing relevance
prefilter (`services/relevance-prefilter.js`, the browser's "AI 精准筛选") about the
new cards of one results page before opening them.

- Switch: `task.relevancePrefilter.enabled` is true only when the child task's
  `planSnapshot.captureSettings` has both `autoDetailCaptureAfterListCapture` and
  `enableAiRelevancePrefilter` strictly true; no plan snapshot means false.
- `POST /agent/prefilter {identity,requestId,cards:[{cardId,title,author}]}` with
  1-8 cards; `cardId` is the phone's sha256 of `[title,author]` (64 lowercase hex,
  unique per request). Returns `{ok:true,enabled,degraded,items}`, one item per card in
  request order: `{cardId,status,modelDecision,tenantRelevance,confidence,
  protectedSignal,executionDisposition,reason}` (reason at most 160 characters). When
  the switch is off, `enabled` is false, `items` is empty and no model is called.
- The attempt is checked in one short transaction (`currentAttempt`: current,
  device held, mobile workflow); the keyword comes from the item, never the phone.
  The model is called only after that transaction commits, so a slow model never
  holds the agent slot or the item/attempt rows (renew keeps working meanwhile).
- The service request is `platform:'douyin'`, `stage:'list'`, `mode:'conservative'`,
  `skipThreshold:0.97`, idempotency key `android:<attemptId>:<requestId>`, and
  `externalId:''` for every card so no record visibility is changed.
- Errors are `{ok:false,error,failOpen:true}`: 400 invalid body, 403 another agent's
  attempt, 409 stale attempt or device not held, 413 more than 8 cards, 422 invalid
  or repeated card, 429 daily quota (Retry-After 60) or busy (Retry-After 1), 503
  unavailable. The auth/flag middleware rejects as on the other agent endpoints.
- The phone skips a card only on the extension's skip predicate (ok, skip,
  irrelevant, confidence in [0,1], not protected, `skip_full_capture`, a real title);
  every other answer or any error opens the card. Completion stats may carry
  `prefilterSkipped`, `prefilterJudged` and `prefilterUnjudged`.

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
`prefilter` owns the card prefilter call; `views` owns bounded projections;
`service` composes them. The router only handles
HTTP, identity, feature flags and error mapping.

Tests: `tests/android-control-route.test.mjs`, `tests/android-card-prefilter.test.mjs`,
`tests/integration/postgres/android-control.integration.mjs` and
`tests/integration/postgres/android-card-prefilter.integration.mjs`. The integration
files require an explicitly isolated PostgreSQL test database and validate real transactions,
concurrent claims/quota allocation, old browser-protocol rejection with a real
token, lease expiry, stop confirmation, explicit resume, historical completion
fences, the actual discovery-ingest lineage contract, and that the card prefilter
holds no lock while its (injected) model works. They are not device QA.
