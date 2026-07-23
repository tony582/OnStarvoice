# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Product decisions for this prototype

- Treat one business task as a parent containing independently assignable keyword work items.
- Keep physical devices and browser Extension executors visible as first-class Agent actors.
- Support manual, rule-based, and rule-plus-AI orchestration in the interaction model.
- Hard eligibility rules always constrain Agent choice; AI may only optimize among eligible Agents.
- A platform safety restriction may generate a takeover proposal for unfinished or retryable work items. Completed results remain attached to the parent task.
- Clearly distinguish “take over unstarted items” from “recapture the current item from a checkpoint”.
- This prototype demonstrates the interaction only. Do not imply that current production APIs already support cross-Agent work-item leases or failover.
