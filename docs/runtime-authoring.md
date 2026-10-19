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
  - instruction: Click Inventory
    context:
      urlIncludes: https://app.example.test/
  - instruction: Click Add item
    aliases: [Add product]
  - instruction: 'Enter "Synthetic delivery note" in Delivery note'
    scope: Shipping details
  - instruction: 'Verify Delivery note has value "Synthetic delivery note"'
    scope: Shipping details
```

`context` is a deterministic precondition: URL substring and/or visible page-text substring. Both must match when supplied. Use it to wait for the correct application or SPA screen. `scope` filters target candidates by nearby text, named ancestor groups or dialog name (case insensitive). It is not a CSS selector or a uniqueness guarantee; the model still has to select one candidate. It applies to control operations and the explicit semantic-container scope of `assert_text_count`; other page assertions are unscoped. `aliases` supplies explicit acceptable alternative control names; DUIT does not silently invent synonyms.

Observation includes semantic controls, accessible links without `href`, custom clickable elements, frames, open shadow roots, overlays and nearby field-group text. Native modal dialogs and `aria-modal="true"` exclude background controls. A nonmodal `role="dialog"` does not imply modality; actual occlusion and Playwright actionability still apply. Named DOM regions and nested custom pointer widgets remain addressable without caller selectors. Offscreen controls can still be scrolled into view by Playwright. Virtualized controls absent from the DOM need an explicit UI step to reveal them. Closed shadow roots and canvas-only controls require another adapter.

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
      text: Welcome to your workspace
      urlIncludes: https://app.example.test/
    action: Click Skip tour
  - name: Tutorial
    when:
      text: Skip tour and close dialog
    action: 'Click "Skip tour and close dialog"'
    maxRuns: 3
```

Rules match visible page text or visible accessible control names. They execute only a click or Escape, have bounded dispatch counts, wait for the notice to disappear, and record each handling attempt. Configure consent behavior for the application being tested. Unknown overlays stop the interaction with evidence; DUIT does not click arbitrary dismiss buttons. Browser actionability checks also invoke the notice handler, so an overlay appearing after a trial check can be dismissed before the actual click. A notice already in progress is excluded from reentrant handling. If a Playwright notice callback fails, its pending action is held until its timeout and the error returns through the normal report boundary; it cannot escape as an unhandled process exception or release the blocked click. The page remains available for inspection. Observation and target resolution can refresh before dispatch; an action is never automatically repeated after dispatch.

## Cleanup, evidence and environment boundaries

`cleanup` is a list of ordinary natural-language steps, executed before closing the browser even after an earlier test failure. It stops on its first failure and prevents a successful overall result if cleanup fails. Use an exact run-specific resource name or identity and assert it before deleting. Cleanup cannot run after cancellation or a dead browser; the report warns about this. Do not use generic “delete first policy” cleanup.

Reports include phase (`context`, `resolve`, `prepare`, `dispatch`, `assert`), failure category, current page evidence, interruption history, recovery links and cleanup results. A failed CDN resource is environment evidence; a missing control is UI evidence; neither should be reported as a fixture validation. Dependency validation belongs in a separate preflight, outside a UI-only case.

Variables are redacted by default. `publicVariables: [API_NAME, STAGE_ID]` keeps nonsecret resource identities readable in reports and screenshots. Never mark credentials public. Form fields remain masked in screenshots.

The CLI accepts browser defaults in YAML (`allowedOrigins`, `localNetworkOrigins`, `channel`, `timeoutMs`, `navigationTimeoutMs`). CLI flags override those lists, rather than append to them. New windows are followed only within allowed origins. Library callers construct `BrowserAdapter` with their own options, then inject it into `runCase` or `HarnessSession`; `case.browser` is interpreted by the CLI.

## Waiting for asynchronous activities

Some UIs show a snapshot of a job and need a reload to show completion. Poll **assertions** explicitly:

```yaml
- instruction: Verify the Completed status element is visible
  scope: "Row 1: DUIT import job"
  wait:
    timeoutMs: 120000
    intervalMs: 5000
    refreshControl: Refresh activity
```

DUIT records `pollAttempts`, re-observes the UI, and can reload the current document between failed assertion attempts. The wait is bounded by its own deadline and the overall run budget. `refreshControl` clicks a uniquely observed visible button by its exact accessible name, without document reload or a model decision. Configure only a read-only refresh control; DUIT cannot infer a button’s server-side effects. Missing or ambiguous refresh buttons stop the wait. Alternatively, `refreshPage` is opt-in: use it on saved read-only views, because reloading discards unsaved form state. It never repeats the preceding Apply/Remove action. Polling is rejected for non-assertion operations, including clicks. Environment failures and unsupported configuration are not converted into repeated assertions. Choose only one refresh method. Set the wait timeout above the normal browser assertion timeout to leave time for retries. Control polling still uses Jev for each new target snapshot; page-text assertions remain deterministic.

An explicit click label that uniquely matches a compatible observed control is bound deterministically (`resolution: exact-label`). Explicit control roles, scopes and aliases can disambiguate that match. Canonical atomic grammar also compiles operations and exact quoted arguments without Jev. Semantic descriptions and nonunique label matches use Jev target selection (`resolution: jev`) with the unchanged confidence gate. This avoids probabilistic rejection of a unique exact label without accepting an uncertain model decision or requiring user-authored selectors.

## Reusable test interaction profile

When a test environment authorizes routine notice handling, use one setup property:

```yaml
interaction:
  profile: test
  maxActions: 10
# Optional short, redacted vocabulary/context for Jev decisions:
decisionContext: Test environment. Inspect configuration and targets without applying policies.
```

`test` accepts recognized cookie banners, dismisses recognized onboarding defers email reminders and discards unsaved test editor changes when exiting. Individual `cookies` (`manual`, `accept`, `reject`), `onboarding` (`manual`, `dismiss`) `reminders` (`manual`, `later`) and `unsavedChanges` (`manual`, `discard`) override the profile. The default without a profile is manual. CLI supports `--interaction-profile test`. The HTTP/MCP case schema exposes the same properties. The profile never chooses a generic confirmation or changes navigation origins; unrecognized notices still require inspection. It uses observed enabled, unobstructed controls, records all actions, verifies disappearance and enforces the configured action limit. Known stacked notices are processed in actionable order. Interrupted dispatch remains uncertain and cannot be automatically repeated.

Canonical atomic instructions compile without model calls: `Click Save`, `Enter "value" in Name`, `Navigate to "https://example.com/"`, `Verify the text "Saved" is visible` and `Verify the text "Error" is not visible`. Unique complete click/fill labels and explicit aliases bind deterministically. Menu prefixes and trimmed link suffixes never count as exact matches. Exposed exact labels take precedence over covered duplicates. A repeated explicit control name restricts Jev to matching names/roles; it never permits a different label. Sole targets inside scrollable catalogs reach Playwright trial actionability so it can scroll them into view. Opacity-zero ancestor content is excluded. Other prose and genuine ambiguities still use Jev with the existing confidence gates. Explicit metadata remains authoritative.

Use JSON or a YAML serializer so `#` and `: ` inside instructions cannot truncate them. `:inspect` and MCP inspections return bounded evidence; every full redacted session observation is saved as `inspection-NNN.json`. Retain an interactive PTY or use MCP; EOF closes `explore`. Export final cases and rerun unattended to prove reproducibility. Count every report when measuring authoring cost, including blocked attempts; calling-LLM billing is not exposed by DUIT.

For exact text counts use `operation: assert_text_count`, `value: Open`, `count: 6`. `scope` limits matches to their nearest semantic container (button/card, article, group, row, fieldset, section, dialog), avoiding unrelated interface text such as a command-palette hint named Open. Counts test DOM-visible literal matches; they do not judge semantic equivalence. Use a bounded `wait` when catalog content loads asynchronously.

The test profile also gives exact click/fill labels a 5-second observation grace period before semantic model targeting (`interaction.exactLabelWaitMs`, 0–30000). This consumes no Jev calls while a SPA adds its navigation controls. Once elapsed, genuine semantic matching retains the existing request budget and confidence gates. Canonical literals and operations, or explicit metadata, need no model interpretation. Input placeholders are included in compact inspection; they can reveal token-entry conventions without another screenshot.

If a configured notice mounts after the initial observation and an assertion times out, DUIT inspects the current view, handles only the newly recognized notice, and repeats **that assertion only** (at most three notice recoveries per assertion and still inside the run/action budgets). It never repeats the preceding click/fill/apply/remove. Recovered errors and handled notice names remain in `step.assertionRecoveries`. Unknown dispatched notice outcomes stop recovery. This also covers dialogs with ARIA `alertdialog`, and custom styled native checkbox/radio inputs whose own opacity is zero remain operable when their parent UI is visible.

## Scope of the defaults

The notice catalog is deliberately bounded: common English and some Spanish cookie, onboarding, reminder and unsaved-draft labels. It does not infer consent from arbitrary prose or guarantee support for every language. Configure explicit interruptions for other observed notices. Site vocabulary, full accessible names and acceptable aliases belong in cases or `decisionContext`; core execution contains no application names, URLs or provider-specific selectors.

Compact inspection preserves unnamed controls with context, placeholders and up to 30 native select options (with an omitted count). It returns at most 100 controls and 6,000 text characters, retaining full sanitized observations on disk. Nearby section context uses preceding headings and stops field-group expansion at semantic/form boundaries, avoiding unrelated sibling forms.

Disallowed subframe navigation remains blocked and recorded as `navigation_blocked`; it does not make an unrelated top-level fill/click uncertain. Top-level and popup origin restrictions still fail closed. Do not add advertising origins to make a workflow pass.

See [cross-site validation](public-workflows.md) for first-attempt evidence, unchanged-case harness retries, independent repeats and cost accounting. A passing first authoring attempt is distinct from a zero-model run or replay.
