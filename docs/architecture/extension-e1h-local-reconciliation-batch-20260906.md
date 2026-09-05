# E1h: local reconciliation consumer batch

## Scope and release boundary

- Isolated branch: `codex/extension-e1h-local-reconciliation-batch-20260906`.
- Exact base: E1g / PR #46 at `946926c6f42ea7523b9770cc443fdf0bdca561ef`.
- Stacked Draft only. No Ready, merge, force push, deployment, migration,
  split, customer Extension update, or edits to existing PR #29 / #37–#46.
- Architecture main remains `51896d8694c4b19e3731e5b6b7623397420c84a9`.
  PR #37 (Cron decoupling) is preserved; this batch does not incorporate it.
- This is preparation of local consumers, not an enabled reliability release.
  The real queue factory still does not provide `shouldHoldForReconciliation`.
  The E1e remote-ACK/local-confirmation producer remains unconnected.

## Implemented together

| Boundary | Change | Compatibility constraint |
| --- | --- | --- |
| Shared signal contract | Pure `sync-reconciliation-state.js` recognizes two strict boolean flags and three exact codes, with only one direct `error` layer and direct streaming flags. | No message matching, recursive body/results scanning, I/O, retry permission, or inferred safety flags. |
| Batch return and exceptional drain | Carry a structured reconciliation error; an exception or late drain signal is not reduced to an ordinary string failure. | Preserve cancellation and platform safety evidence. Existing no-signal errors keep their shape. |
| Unattended terminal and catch | Explicit hold projects to `needs_action`, without a local elastic handoff; preserve attempt fencing and cancellation/safety priority. | Does not change server recovery. A status label alone is not proof of no replay. |
| Upload closure evidence | Top-level or error-only hold also invalidates a nominally drained streaming snapshot; use a copy and preserve source counts. | No fabricated completion evidence; no changes to backend/background closure predicate. |
| Targeted adapter and outer loop | Stop before the next target, retain an invocation-local hold across status-report failures, and report run `needs_action`. Existing held input stops before acquiring/opening a new work page. | Target result remains the protocol-compatible `failed` envelope, with distinct flag and `sync.status=needs_action`. Checkpoint settled/failed counting is unchanged. |
| Manual sync and detail auto-sync | Hold wins over success/retry copy. Refresh or cancellation cannot erase an already received hold; auto-sync retains returned result/error evidence. | Ordinary success, partial failure, disabled/canceled paths stay unchanged. No durable lock/resume mechanism added. |
| Recovery requirements | Unwired pure prototype returns `require_reconciliation` with replay/success blocked, or `defer_existing`. | The latter is not permission to retry. Not imported by shipped/runtime code. |

`cloud-targeted-post.js` must remain a classic script: it is loaded both by
background `importScripts` and by the sidebar. Its small private signal adapter
is intentionally dependency-free; parity tests bind it to the shared ESM rules.

## Known unimplemented gates — do not enable the producer

1. The real server elastic recovery projection still maps these incomplete
   statuses to retryable despite local flags / `retryable:false`. Negative
   characterization tests execute the actual server function to expose this.
2. Monitor finish treats every status other than `failed` as `succeeded`.
   Sending `needs_action` would therefore create false success; sending ordinary
   failure can schedule another run after roughly 15 minutes. Monitor runtime
   and its server protocol are deliberately unchanged.
3. Durable remote receipts, restart recovery, exact attempt/operation fencing,
   safe confirmation-only replay, and cross-device recovery remain unimplemented.
   The targeted latch is only invocation-local, not durable receipt storage.
4. This is not full consumer closure: automatic collection loops, monitor
   dispatch, and remaining manual capture terminal paths still need explicit
   review before producer activation. Passing local tests does not authorize it.
5. UIUX redesign and code-origin / MediaClaw independence remain separate work.
   Extraction, new names, or this reliability batch do not establish IP clearance.

## Verification

- Node 24.12.0 and Node 18.20.8: **2052/2052 each**, zero failures/skips;
  E1g baseline was 1976. Logs:
  `/tmp/onstarvoice-e1h-node24-final-20260906.log` and
  `/tmp/onstarvoice-e1h-node18-final-20260906.log`.
- New tests: targeted adapter 12, shared state 12, server/monitor recovery
  boundaries 14, sidebar unattended/targeted consumers 28, manual/auto sync 10.
  Existing characterization assertions were explicitly upgraded where behavior
  intentionally changed; unrelated assertions were retained.
- Independent no-signal targeted differential checks: 1050 cases identical to
  E1g. Independent review found and then revalidated closure/report-error/safety
  preservation fixes. No remaining blocker within this bounded scope.
- Snapshot check: **100 files**, version still **0.4.5**, compared with E1g 99;
  the additional file is the shared pure signal module. No release packaging
  or customer delivery was performed.
- Repository hygiene: **765 source files**, clean diff whitespace check.
- Browser final paired runs: E1g Chrome / Edge **22 scenarios each**;
  E1h Chrome / Edge **25 scenarios each**. Final candidate directories are
  `output/playwright/e1h-chrome-run-4` and `e1h-edge-run-4` in the QA worktree;
  bases use `e1h-base-chrome-run-1` and `e1h-base-edge-run-1`.
  Actual warnings are readable and dismissible in both browsers.
- Aggregate browser/network evidence: `output/playwright/e1h-final-network-audit.log`
  and `browser-validation-summary.json` in the QA worktree; 31 successful runs
  retained across the architecture stack, including pre-final run 3 separately.
- Customer checkout `extension-build` remains **95 files**, byte-identical to
  the isolated stable package baseline. Sorted path/hash manifest digest:
  `a47d62ca2d900653ca4c228e051ee9868d8a2dd3755faf221c4971a1d402bce8`.
- Runtime producer/storage/queue/server, manifest, background, and content
  scripts are unchanged against E1g. Original dirty checkout work was preserved.
- Hosted CI is a separate post-push gate; consult the Draft PR checks for the
  exact committed head. Local/browser success does not imply CI or release.

Test design includes real sidebar sections executed with I/O seams, not copied
decision logic. Fixtures cover contradictory `ok:true`, top-level/error-only
hold, false drain evidence, cancellation, platform safety, failed progress
reports, stale attempts, legacy no-marker paths, and unsupported nested markers.
Pure negative tests deliberately retain the unresolved server/monitor behavior.

Browser QA uses the separate
`OnStarvoice-extension-browser-validation-20260905` worktree and disposable
profiles. Actual shipped ESM/classic adapters and warning rendering are tested;
full cloud capture/monitor workflows are not exercised. The harness does not
load the original customer package into a personal browser or trigger a task.

Browser fixture development retained failed runs 1–2 for both browsers: the new
probe omitted the target identity / allowed-target list required by the existing
normalizer. Fixing the fixture, not weakening the normalizer, resolved this.
Run 3 passed; run 4 rechecks the final safety-evidence patch.

Production startup update requests are denied by the fixture proxy. Platform
fixtures forward only to loopback. The netlog audit also reports unsuccessful
browser IPv6 route probes; this is not a claim of OS-level packet isolation or
zero attempted external connections. No customer-platform/API acceptance,
8-hour soak, or 72-hour stability validation is claimed.

## Next safe batch

Keep this PR Draft. Before any real producer is enabled, design and separately
authorize the server/monitor protocol plus durable receipt/recovery gate, then
test accepted-server/local-confirmation failure end to end. Do not compensate
by automatic re-upload, clearing local data, or weakening platform waits.
