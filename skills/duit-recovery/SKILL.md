---
name: duit-recovery
description: Recover a blocked DUIT UI session without duplicating mutations. Diagnose current context, notices, network evidence and uncertain dispatches using DUIT MCP or explore mode.
---

# Recover the current UI session

Use the current session ID. A checkpoint is evidence, not an action script. Do not open another session or rerun the whole case simply because a step failed.

1. Read the failed step's phase, category and error. Inspect the current URL, visible controls and dialogs with `duit_inspect`; use `duit_screenshot` if needed. The calling model receives a screenshot only when that tool is requested.
2. For `compile`, `context`, `resolve` or `prepare` failures, correct an atomic instruction using observed labels, section scope, explicit control metadata or context. Use `duit_retry`; it enforces whether retry is allowed. A changed target after preparation must be inspected again.
3. For `ACTION_OUTCOME_UNKNOWN` or an interrupted `dispatch`, do not repeat the action. Find an independent deterministic assertion of the result and use `duit_confirm`. If the UI cannot establish the result, report the block and leave the mutation uncertain. A failed confirm is not permission to retry a mutation.
4. For delayed activity, assert the current operation's identity and status together, avoiding an old Completed row. Configure bounded assertion polling and the UI's read-only refresh button. Do not repeat Apply/Remove because the list is stale.
5. For a blank page, inspect resource/network diagnostics. Pre-login 401 alone is normal. Distinguish connectivity, DNS/VPN/CDN failures and local-network browser permission from missing UI controls. Do not change assertions to make a broken page pass.
6. For visual errors, distinguish missing/ambiguous target, insufficient confidence and changed viewport. Re-inspect and fix the description or return to DOM interaction. Do not lower confidence gates merely to force a click or reuse a stale box.
7. For request/cost limits, report recorded usage and whether a change remains to be cleaned up. Raising the limit is a user tradeoff; do not silently alter the budget. An in-flight model call can exceed an estimate. Unknown-price models need explicit rates.
8. Finish through `duit_session_close` so configured cleanup runs. Cancellation shuts down the browser and may prevent cleanup; inspect the actual resource in a later authorized recovery session before creating anything again.

CLI equivalents: `explore`, `:inspect`, `:screenshot`, `:retry`, `:confirm`, `:continue`, `:finish`. Only the running interactive session retains the browser. DUIT does not reconnect to a browser after its process has exited.
