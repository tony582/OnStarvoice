# Android discovery and browser detail pipeline

The HTTP feature gate defaults closed. `ANDROID_DISCOVERY_INGEST_TENANTS` is a
comma-separated allowlist; applying migrations does not enable or run a pilot.
The mobile control plane is in `../android-control/` and
`../../routes/android-control.js`; the runner is in `../../../runners/android/`.

## Responsibilities

| Module | Responsibility |
| --- | --- |
| `service`, `repository`, `lineage`, `validation`, `state` | Authenticated ingestion, immutable event receipts, attempt ownership and canonical candidate persistence |
| `identity`, `share-resolver` | Douyin URL identity, bounded first-party redirects, public DNS validation and pinned HTTPS connections |
| `detail-dispatch` | Browser capability admission and real task/item/attempt/create-command materialization |
| `detail-receipt`, `ui-binding` | Same-transaction formal record receipt, strict current attempt and independently captured body/author/kind checks |
| `detail-projection` | Terminal task/item/attempt projection using persisted observations, not client success alone |
| `detail-lifecycle` | Shared-demand batch stop and expired create reconciliation |
| `management` | Read-only candidate/evidence view and explicit idempotent reprocessing |

Every new module is below 350 lines. Existing capture-cloud, record-store and
Extension files contain only the required integration points; phone control
and URL resolution are not added to those existing large files.

## Two authenticated channels

Mobile nodes use `capabilities.agentKind = "android_mobile"` plus
`mobileSearchDiscoveryV1`. Registration, expiring device leases, pull/heartbeat,
completion and stop are implemented by the separate Android control plane.
Browser nodes use their existing protocol and advertise `discoveredPostCaptureV1`.
A phone cannot claim a browser task, and an old Extension cannot claim or receive
a new discovered-work task.

Mobile event endpoints:

- `POST /api/capture-cloud/agent/discoveries`
- `GET /api/capture-cloud/agent/discovery-receipts?batchId=...`

The server derives tenant, node, auth code and binding from the authenticated
Agent token and rechecks their active status. Events require UUID eventId,
discoveryRunId, taskId, itemId, attemptId and agentId; a request hash and assignment
revision bind each event to historical task ownership. Missing or expired
windows, stop intent and superseded attempts retain audit evidence only. Forged
ownership is rejected. Each upload contains at most five events.

Each event, candidate and run-demand association commit together. Replay uses
the same event and batch identifiers and the frozen payload hash. A timeout is
not permission to create a new batch. The original immutable receipt remains
available; current candidate/record state is exposed by the management view.

## Discovery to formal record

A canonical work with verified or `ui_bound` evidence can become a `queued`
candidate and an active demand. `ui_bound` means the phone matched the search
card and current detail, and obtained a fresh copied link; it does not assert an
independently verified work ID. Migration 089 permits this separate state.

Before formal ingestion or reuse of an existing record, the independent browser
record must match every applicable normal UI-bound demand: full caption (NFC and
whitespace normalization only), actual author including emoji, and media kind.
A mismatch rolls back the formal write or marks existing-record reuse as needing
attention. A truncated share caption is never independent proof.
Candidates are unique per tenant/platform/externalId and are not formal records
or daily report counts. Existing records retain their classification; hidden
records are shown with their actual visibility and a demand needing attention.
Candidate locking precedes the formal-record lookup, preventing a stale empty
lookup from erasing a concurrently committed receipt.

A compatible idle browser heartbeat claims one candidate and atomically creates
`capture_tasks`, `capture_task_items`, `capture_task_item_attempts` and a real
create command. The `discovered_post_capture` target contains candidateId and
externalId, never a fabricated recordId. The Extension opens the canonical
work, captures details/comments through its existing runner, and syncs with the
exact server attempt identity. The author extractor includes the scoped fix
that prevents caption @mentions from becoming publisher identity.

`record-store` writes the formal record/observation and updates candidate/demand
receipts in the same transaction. A completed client snapshot without that
receipt becomes `needs_action`. If the same valid current attempt's sync arrives
later, the transaction recovers the task/item/attempt to completed. Stopped,
superseded, wrong-work and missing-lineage results cannot do this.

Several runs can share one candidate and one detail task. Exactly one active
run is the detail owner. Stopping one run cancels only its demand; stopping the
last active demand sends a browser stop fence, including when create may be in
flight. Pending stop is not physical-stop confirmation. Lock ordering is mobile
run, then all affected detail tasks, then candidates, then items.

## Resolution and manual recovery

Short links resolve outside database transactions with a three-second service
deadline, at most four requests, exact allowed hosts, validated public DNS and
pinned connection addresses. Malicious redirects, credentials, private/reserved
addresses, ambiguous identity and failures stay reviewable. No title-based
identity inference or hidden-record reinstatement is performed.

Tenant session endpoints:

- `GET /api/capture-cloud/tasks/:id/discoveries` returns up to 100 candidates and
  100 events plus a truncation indicator; this is read-only.
- `POST /api/capture-cloud/tasks/:id/discoveries/reprocess` requires tenant write
  access and `{requestId, eventIds?, candidateIds?}` with 1–5 selections. eventIds
  means the event key returned as `eventId`, not the receipt row ID.

Reprocessing stores an idempotent request receipt. Resolution occurs before the
final transaction; that transaction locks/rechecks the mobile run so a concurrent
whole-batch stop cannot recreate demand. Canceled demand and unverified/late
mobile evidence cannot be promoted. Failed detail tasks are explicitly requeued;
active work and existing formal records do not receive duplicate jobs. There is
no automatic timer-based short-link retry worker in this version.

## Validation and remaining device work

Local tests cover canonical identity, private/mixed DNS, redirects, payload
replay, capability isolation, genuine PostgreSQL task creation and record sync,
shared-demand cancellation, real Extension snapshot mirroring, late receipt
recovery, and concurrent stop/reprocess and receipt persistence.

The Smartisan DE106 physical pilot and separate real Extension detail tests are
recorded in `docs/hotfix/20260923-android-p0-validation.md`. The phone was upgraded
from Douyin 30.6.0 to 40.6.0 during testing; evidence from those versions is kept
separate. Sustained unattended search and full phone-to-browser acceptance remain
required. The feature stays gated until the pilot passes. The implementation and tests do not prove extra search recall
or authorize production deployment, activation, or an unattended schedule.
