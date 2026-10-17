# Adopting DUIT for a new UI

DUIT uses Jev to choose operations, literal values and observed controls. It does not use another LLM to plan recovery, generate selectors or judge success. Write atomic steps and explicit assertions; a broad goal such as “configure and deploy a policy” must be broken down into steps.

## Author while retaining the browser

```bash
npm run duit -- explore examples/omni-header-injection.en.yaml --budget 3600000
```

`explore` executes the case until a step blocks, then retains the same browser and authentication. Enter another natural-language step or a JSON step object. Commands:

| Command                                       | Behavior                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `:inspect`                                    | Show the current URL, visible text, dialogs and controls with their surrounding context. |
| `:screenshot`                                 | Save a masked screenshot in the session directory.                                       |
| `:retry`                                      | Retry an unresolved step that has not dispatched an action.                              |
| `:retry {"instruction":"Click Apply Policy"}` | Replace a failed step using natural language or a structured step.                       |
| `:confirm Verify "Policy applied" is visible` | Confirm an uncertain dispatched action using an assertion, without repeating it.         |
| `:continue`                                   | Resume the remaining planned steps after the blocked step was recovered.                 |
| `:finish`                                     | Run configured cleanup, close the browser and finalize reports.                          |

A dispatched action that times out may have succeeded. DUIT records `ACTION_OUTCOME_UNKNOWN` and prohibits automatic replay. Inspect the page and confirm its actual outcome. Failed confirmation assertions can be retried; they cannot be replaced with another mutation. A checkpoint is written before each main action. `checkpoint.json` records phases and recovery links, but it is **not a browser snapshot or a crash-resume script**. If the process dies, inspect the resource in a new session before taking another action. Interactive sessions do not export a replay because exploratory failures and corrections are not a validated linear case.

An interactive report can pass only with a successful assertion and all recorded failures recovered. A successful exploratory report proves its recorded checks, not every business requirement you may have intended. Promote the final sequence to YAML and run it unattended to validate repeatability.

## Context, scopes and aliases

```yaml
steps:
  - instruction: Click Governance Strategies
    context:
      urlIncludes: https://test1.omni.mulesoft.com/
  - instruction: Click Add Policy
    aliases: [Apply Policy]
  - instruction: 'Enter "X-Backend-Source" in Key'
    scope: Inbound Header Injection
  - instruction: 'Verify Key has value "X-Backend-Source"'
    scope: Inbound Header Injection
```

`context` is a deterministic precondition: URL substring and/or visible page-text substring. Both must match when supplied. Use it to wait for the correct application or SPA screen. `scope` filters target candidates by their surrounding text or dialog name (case insensitive). It is not a CSS selector or a uniqueness guarantee; the model still has to select one candidate. It applies to control operations, not page-wide text/URL assertions. `aliases` supplies explicit acceptable alternative control names; DUIT does not silently invent synonyms.

Observation includes semantic controls, accessible links without `href`, custom clickable elements, frames, open shadow roots, overlays and nearby field-group text. Background controls covered by a dialog are excluded from actions. Offscreen controls can still be scrolled into view by Playwright. Virtualized controls absent from the DOM need an explicit UI step to reveal them. Closed shadow roots and canvas-only controls require another adapter.

## Expected interruptions

```yaml
interruptions:
  - name: Cookie consent
    when:
      text: We use cookies
    action: Click ACCEPT ALL COOKIES
    maxRuns: 2
  - name: Welcome
    when:
      text: Welcome to Agent Fabric
      urlIncludes: https://test1.omni.mulesoft.com/
    action: Click Start exploring
  - name: Tutorial
    when:
      text: Skip tour and close dialog
    action: 'Click "Skip tour and close dialog"'
    maxRuns: 3
```

Rules match visible page text or visible accessible control names. They execute only a click or Escape, have bounded dispatch counts, wait for the notice to disappear, and record each handling attempt. Configure consent behavior for the application being tested. Unknown overlays stop the interaction with evidence; DUIT does not click arbitrary dismiss buttons. Browser actionability checks also invoke the notice handler, so an overlay appearing after a trial check can be dismissed before the actual click. A notice already in progress is excluded from reentrant handling. If a Playwright notice callback fails, its pending action is held until its timeout and the error returns through the normal report boundary; it cannot escape as an unhandled process exception or release the blocked click. The page remains available for inspection. Observation and target resolution can refresh before dispatch; an action is never automatically repeated after dispatch.

## Cleanup, evidence and environment boundaries

`cleanup` is a list of ordinary natural-language steps, executed before closing the browser even after an earlier test failure. It stops on its first failure and prevents a successful overall result if cleanup fails. Use an exact run-specific resource name or identity and assert it before deleting. Cleanup cannot run after cancellation or a dead browser; the report warns about this. Do not use generic “delete first policy” cleanup.

Reports include phase (`context`, `resolve`, `prepare`, `dispatch`, `assert`), failure category, current page evidence, interruption history, recovery links and cleanup results. A failed CDN resource is environment evidence; a missing control is UI evidence; neither should be reported as an AWS fixture validation. Dependency validation belongs in a separate preflight, outside a UI-only case.

Variables are redacted by default. `publicVariables: [API_NAME, STAGE_ID]` keeps nonsecret resource identities readable in reports and screenshots. Never mark credentials public. Form fields remain masked in screenshots.

The CLI accepts browser defaults in YAML (`allowedOrigins`, `localNetworkOrigins`, `channel`, `timeoutMs`, `navigationTimeoutMs`). CLI flags override those lists, rather than append to them. New windows are followed only within allowed origins. Library callers construct `BrowserAdapter` with their own options, then inject it into `runCase` or `HarnessSession`; `case.browser` is interpreted by the CLI.

## Waiting for asynchronous activities

Some UIs show a snapshot of a job and need a reload to show completion. Poll **assertions** explicitly:

```yaml
- instruction: Verify the Completed status element is visible
  scope: "Row 1: Aws Header Mapping Removed"
  wait:
    timeoutMs: 120000
    intervalMs: 5000
    refreshControl: Refresh activity
```

DUIT records `pollAttempts`, re-observes the UI, and can reload the current document between failed assertion attempts. The wait is bounded by its own deadline and the overall run budget. `refreshControl` clicks a uniquely observed visible button by its exact accessible name, without document reload or a model decision. Configure only a read-only refresh control; DUIT cannot infer a button’s server-side effects. Missing or ambiguous refresh buttons stop the wait. Alternatively, `refreshPage` is opt-in: use it on saved read-only views, because reloading discards unsaved form state. It never repeats the preceding Apply/Remove action. Polling is rejected for non-assertion operations, including clicks. Environment failures and unsupported configuration are not converted into repeated assertions. Choose only one refresh method. Set the wait timeout above the normal browser assertion timeout to leave time for retries. Control polling still uses Jev for each new target snapshot; page-text assertions remain deterministic.

An explicit click label that uniquely matches a compatible observed control is bound deterministically (`resolution: exact-label`). Explicit control roles, scopes and aliases can disambiguate that match. Jev still classifies the natural-language operation and selects literal values. Semantic descriptions and nonunique label matches use Jev target selection (`resolution: jev`) with the unchanged confidence gate. This avoids probabilistic rejection of a unique exact label without accepting an uncertain model decision or requiring user-authored selectors.
