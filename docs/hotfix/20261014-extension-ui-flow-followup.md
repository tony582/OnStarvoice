# Extension UI follow-up — local QA, not released

Date: 2026-10-14. Branch: `codex/extension-ui-refresh`.

This record describes the local QA completed before release authorization. At that point no commit, push, package replacement, deployment, or real-node reload had been performed. The follow-up was subsequently published in 0.4.25 after the user requested deployment; see `20261014-extension-ui-0425.md` for the production receipt. It was not included in 0.4.24.

## Changes

- Preserve the selected Creative view when sampling refreshes the current webpage. Explicit navigation still leaves Creative. Respect the original renderer's eligibility checks when the webpage temporarily changes.
- Place shared capture feedback in a reserved layout row, not over the form or bottom action dock. Keep original dedicated Creative stop buttons available through sampling and AI analysis, including when a child capture hides shared progress. Preserve recovery and keyword-plan controls. Reposition only the minimized debug dock when progress is visible; the fullscreen runtime panel is unchanged.
- Flatten the monitoring list: one outer section, account rows separated by rules, unboxed metadata, and original pause/resume/delete controls with visible labels. Preserve every existing field and action.
- Remove Weibo entry points and platform guidance from the opt-in new UI. Only Xiaohongshu and Douyin remain in the platform menu. A detected Weibo page shows an unsupported-platform notice instead of startable capture forms. Do not delete historical records or change the underlying platform registry, capture implementation, or classic UI compatibility.

## Scope and compatibility

Production changes are limited to `sidebar/ui-next.js` and `sidebar/ui-next.css`. Remaining changes are isolated preview fixtures and regression tests. The opt-in/classic rollback mechanism remains intact. No new production polling, timers, observers, or network requests were added.

The development gate confirms 92 protected code files match both HEAD and the existing `extension-build` snapshot; the manifest matches apart from its release version. This includes the original capture, state, background, task, and utility implementations. The shipping snapshot was not modified.

## Validation

- `node scripts/check-extension-ui.mjs`: 202 tests passed.
- `git diff --check`: passed.
- Isolated browser lifecycle exercise: 84 checks passed at both 438 × 763 and 318 × 562 content viewports. Covers Creative opportunity/benchmark/long-tail, note/blogger/search, batch links/bloggers, waiting, detail-page transitions, AI analysis, completion, errors, stopping, recovery, long feedback, and restoration of controls.
- Existing browser compatibility exercise: 47 checks passed immediately after the lifecycle exercise, including repeated new/classic switching and original control/value/parent restoration.
- Monitoring page visually checked at 440 px and 320 px, with no horizontal overflow; metadata and action labels remain visible.
- Weibo detection and platform menu checked in the isolated browser; historical content was not filtered or removed.

These are local UI and simulated lifecycle checks, not real collection, backend sync, unattended-node, or CPU/memory acceptance. Real-node acceptance remains a separate step on an idle authorized node.

## Visual evidence

Saved under `outputs/extension-ui-20261014-flow/`:

- `monitor-440.png`, `monitor-320.png`
- `creative-waiting-440.png`, `creative-waiting-320.png`
- `supported-platforms-320.png`

Preview: <http://127.0.0.1:4178/>. It uses demonstration data, does not connect to the backend, and does not run real capture tasks.
