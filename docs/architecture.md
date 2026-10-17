# Harness design

## Contracts

- `DecisionProvider.decide(state, questions, signal)` returns typed Choice answers. `JevProvider` implements the official `POST /v1/systemone` protocol, validates the schema and verifies that each selection belongs to the criteria, checks distributions, and handles timeouts/retries. The transport knows only about the TypeSafe API.
- `DecisionEngine` classifies steps in batches of up to eight, chooses literals, and resolves elements. It uses `unsupported`/`none` options and never falls back to generation. It records the redacted request and response, making it possible to audit alternatives and calibrate the policy against your own cases.
- `PlatformAdapter` opens the platform, observes candidates for an optional step, executes actions, and produces evidence. It may expose `diagnostics()` with connection configuration and network events, `prepare()` for actionability trials, and `setInterruptionHandler()` to resolve late overlays during native actionability checks. `BrowserAdapter` is the first implementation. The candidate/locator contract retains DOM terminology in this proof of concept; extending it to mobile would require versioning or generalizing that contract.
- `runCase` controls ordering, the overall budget, cancellation, variable resolution, resource cleanup, and results. It does not use the model to determine success. The API accepts a per-step callback and injected providers/adapters.
- `saveArtifacts` persists JSON, HTML, JUnit, and replay. New directories prevent old evidence from being mistaken for a recent failure. Replay uses the same adapter and assertions.

## Fixed decisions

1. Case validation. Each step is limited to 2,000 characters, and a case can have up to 200 steps plus 50 cleanup steps. Initial URLs must use HTTP(S).
2. Jev selects an operation from the catalog. A compound instruction should be classified as `unsupported`; this detection remains probabilistic, so authors must write atomic steps and review the evidence.
3. For operations with arguments, code extracts quotes, references, or contiguous spans; Jev chooses a candidate or `none`. Values are never invented. Data that must be generated can be prepared deterministically before calling the harness.
4. Before acting, Playwright obtains a snapshot of controls/text. The engine filters by compatibility (a fill cannot target a button) and offers up to 240 candidates. Exceeding the limit blocks explicitly; the eligible set is never silently truncated.
5. An explicit click label with one eligible observed match binds that locator deterministically. Otherwise Jev chooses a target. The policy requires sufficient probability, margin over the second choice, and confidence. Probability and confidence do not guarantee correctness; thresholds should be calibrated against the user's corpus.
6. Playwright executes a closed operation with a strict locator. It prefers a unique test id, label, or role/name; otherwise it uses observed CSS. Jev-generated selectors, evals, and invented actions are not accepted.
7. Assertions use Playwright `expect`/polling. Only successful execution of all actions and assertions produces `passed`.

Page assertions (text and URL) do not need an element selection. Control assertions use an explicit observed control contract or Jev to identify the control, and Playwright to measure its state. This removes an LLM judge from the result but does not eliminate interpretation errors: always review that the resolved case represents the intended behavior.

## Navigation, selectors, and async behavior

Each run opens an isolated context. The starting point is `baseUrl`; explicit navigation/URL paths resolve relative to it. The adapter blocks document navigation to other origins unless allowlisted, including in iframes. `storageState` can be loaded for sessions prepared externally. New windows are adopted after validating their origin and document readiness; their network diagnostics are attached before navigation completes.

Locators are resolved again when an action runs. Playwright requires uniqueness and actionability; a snapshot does not guarantee that a DOM changed between decision and action will retain the same identity. Structural CSS locators and frame indexes have explicit limitations. For critical applications, prefer stable test ids and validate identity in a purpose-built adapter.

Actions with side effects are not retried. Assertions use auto-waiting. Observation waits up to `navigationTimeoutMs` for at least one compatible candidate, tolerating rendering after DOMContentLoaded and navigation context transitions. `StepExecutor` refreshes observations and bounded target decisions before dispatch, checks explicit page context, and resolves configured interruptions. The same executor powers `runCase` and the retained `HarnessSession`. Playwright trial actionability allows a fresh observation if a notice or SPA transition invalidated the target; actual dispatched actions are never replayed. There is no autonomous route discovery. Very large lists, controls not exposed in the DOM, and open-ended steps are blocked.

Document navigation and control readiness use a separate timeout from actions/assertions. The browser inherits standard HTTP(S) proxy variables and NO_PROXY; explicit options override them. Reports retain up to 100 network/HTTP failure events, stripping proxy credentials, query strings, and fragments. Subresource HTTP 4xx/5xx responses are diagnostic evidence rather than automatic failures: a profile 401 before authentication is normal on MuleSoft. HTTP 4xx/5xx responses to explicit document navigation do block the run.

## Variables and reproducibility

`${NAME}` is preserved as a reference during decisions; `env:NAME` loads a value in the runner. Variable references are resolved for target descriptions and scopes before decision (secret values are redacted before transmission), and for literal arguments when executed. `publicVariables` opts nonsecret resource identities out of redaction. The CLI also uses them to mask screenshots. The library API lets callers supply `maskValues` to the adapter for the same masking. Form fields are always masked.

Replay plans are validated with Zod and contain no code. They are exported only from successful runs, preserve format versions, and do not require a provider. Inline variable values are replaced by environment references in the plan. If a locator literally contains a redacted secret, replay may fail: secret locators are not reconstructed. Fixtures should give controls stable identities.

The model defaults to the pinned `jev-1.14.0`. Changing the model or policy requires rerunning the evaluation corpus; equivalence should not be assumed. The demo scenarios do not support a statistical reliability guarantee.

## Reasonable future extensions

- A versioned corpus with operation/target labels and accuracy, rejection, and false-positive metrics by language/UI.
- Specialized candidate providers for product components, robust frame identity, and virtualized rendering.
- Typed environment preflight and fixture contracts, beyond the implemented UI `cleanup` steps.
- Assertion plugins with typed contracts and domain-specific validation.
- A run queue, per-user isolation, and a web editor on top of the existing API.

These extensions are not implemented and are not required to run the current examples.

See [runtime authoring](runtime-authoring.md) for context/scoping semantics, bounded interruptions, checkpoints and recovery limitations. Interactive reports preserve failed attempts and their recovery links; successful interactive sessions deliberately do not export a replay.

## Service and optional model boundaries

`DuitService` owns asynchronous runs and retained sessions. `PlatformRegistry` supplies adapters; the browser service factory is the only default-service layer constructing Playwright. HTTP and MCP share capacity, lifecycle, inspection and recovery behavior. They are trusted local interfaces, not a multi-user isolation boundary.

`PlatformAdapter.observeVisual` and `DecisionProvider.locate` are optional capabilities using a platform-neutral image, revision and normalized box contract. The browser adapter owns screenshot masking, coordinate conversion and stale-frame checks. Core orchestration cannot turn visual decisions into arbitrary code or assertions. Nonvisual adapters need not implement image support.

`ContentProvider` is separate from `DecisionProvider`. An explicitly configured `FieldWriter` produces bounded text only for fill steps; its cache, cost and replay literals are independent from Jev decisions. `MeteredProvider` accounts for Jev calls per run. Explicit operation/value/control steps and generic single-field roles can avoid model calls without weakening ambiguous-target gates.
