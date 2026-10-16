# Harness design

## Contracts

- `DecisionProvider.decide(state, questions, signal)` returns typed Choice answers. `JevProvider` implements the official `POST /v1/systemone` protocol, validates the schema and verifies that each selection belongs to the criteria, checks distributions, and handles timeouts/retries. The transport knows only about the TypeSafe API.
- `DecisionEngine` classifies steps in batches of up to eight, chooses literals, and resolves elements. It uses `unsupported`/`none` options and never falls back to generation. It records the redacted request and response, making it possible to audit alternatives and calibrate the policy against your own cases.
- `PlatformAdapter` opens the platform, observes candidates, executes actions, and produces evidence. `BrowserAdapter` is the first implementation. The candidate/locator contract retains DOM terminology in this proof of concept; extending it to mobile would require versioning or generalizing that contract.
- `runCase` controls ordering, the overall budget, cancellation, variable resolution, resource cleanup, and results. It does not use the model to determine success. The API accepts a per-step callback and injected providers/adapters.
- `saveArtifacts` persists JSON, HTML, JUnit, and replay. New directories prevent old evidence from being mistaken for a recent failure. Replay uses the same adapter and assertions.

## Fixed decisions

1. Case validation. Each step is limited to 2,000 characters, and a case can have up to 100 steps. Initial URLs must use HTTP(S).
2. Jev selects an operation from the catalog. A compound instruction should be classified as `unsupported`; this detection remains probabilistic, so authors must write atomic steps and review the evidence.
3. For operations with arguments, code extracts quotes, references, or contiguous spans; Jev chooses a candidate or `none`. Values are never invented. Data that must be generated can be prepared deterministically before calling the harness.
4. Before acting, Playwright obtains a snapshot of controls/text. The engine filters by compatibility (a fill cannot target a button) and offers up to 240 candidates. Exceeding the limit blocks explicitly; the eligible set is never silently truncated.
5. Jev chooses a target. The policy requires sufficient probability, margin over the second choice, and confidence. Probability and confidence do not guarantee correctness; thresholds should be calibrated against the user's corpus.
6. Playwright executes a closed operation with a strict locator. It prefers a unique test id, label, or role/name; otherwise it uses observed CSS. Jev-generated selectors, evals, and invented actions are not accepted.
7. Assertions use Playwright `expect`/polling. Only successful execution of all actions and assertions produces `passed`.

Page assertions (text and URL) do not need an element selection. Control assertions use Jev to interpret which control the step refers to, and Playwright to measure its state. This removes an LLM judge from the result but does not eliminate interpretation errors: always review that the resolved case represents the intended behavior.

## Navigation, selectors, and async behavior

Each run opens an isolated context. The starting point is `baseUrl`; explicit navigation/URL paths resolve relative to it. The adapter blocks document navigation to other origins unless allowlisted, including in iframes. `storageState` can be loaded for sessions prepared externally. Popups are detected as unsupported.

Locators are resolved again when an action runs. Playwright requires uniqueness and actionability; a snapshot does not guarantee that a DOM changed between decision and action will retain the same identity. Structural CSS locators and frame indexes have explicit limitations. For critical applications, prefer stable test ids and validate identity in a purpose-built adapter.

Actions with side effects are not retried. Assertions use auto-waiting. Target resolution currently takes one snapshot per step: there is no autonomous search, exploratory scrolling, or route recovery. Very large lists, controls not exposed in the DOM, and open-ended steps are blocked.

## Variables and reproducibility

`${NAME}` is preserved as a reference during decisions; `env:NAME` loads a value in the runner. Variable values are substituted only when the argument is executed. The CLI also uses them to mask screenshots. The library API lets callers supply `maskValues` to the adapter for the same masking. Form fields are always masked.

Replay plans are validated with Zod and contain no code. They are exported only from successful runs, preserve format versions, and do not require a provider. Inline variable values are replaced by environment references in the plan. If a locator literally contains a redacted secret, replay may fail: secret locators are not reconstructed. Fixtures should give controls stable identities.

The model defaults to the pinned `jev-1.14.0`. Changing the model or policy requires rerunning the evaluation corpus; equivalence should not be assumed. The demo scenarios do not support a statistical reliability guarantee.

## Reasonable future extensions

- A versioned corpus with operation/target labels and accuracy, rejection, and false-positive metrics by language/UI.
- Specialized candidate providers for product components, robust frame identity, and virtualized rendering.
- Explicit fixtures/setup/teardown and deterministic generation of test data.
- Assertion plugins with typed contracts and domain-specific validation.
- A run queue, per-user isolation, and a web editor on top of the existing API.

These extensions are not implemented and are not required to run the current examples.
