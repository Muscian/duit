# Cross-site workflow validation — 2026-10-19

## What was measured

Five final public workflows passed **96/96 steps** from fresh Chromium contexts. Coffee Cart and TodoMVC also passed **46/46 replay steps**, with zero model decisions. The previous seven-scenario public corpus passed again (30 steps, including real Jev image targeting). Local checks: 85 passed, eight opt-in live tests skipped by the offline command; TypeScript check/build and case-schema validation passed. Raw reports, masked screenshots, logs, frozen cases, preparation and measurements are saved in the workspace bundle `/workspace/output/duit-generalization`. The committed [ledger](validation/public-workflows-2026-10-19.json) contains every measured attempt and its artifact key.

All public UI actions used DUIT's CLI, HarnessSession or runCase, after reading the installed schema and authoring/recovery skills. No caller-supplied Playwright selectors, generated action code, external planning LLM, credentials or real payments were used. Browser internals generate locators. Calculator expectations were computed independently from synthetic inputs. These are examples, not a reliability benchmark.

## Final live validation

| Case              | Steps |   Time | Jev requests | Estimated USD |
| ----------------- | ----: | -----: | -----------: | ------------: |
| blaze-reservation | 19/19 | 13.50s |            4 |   $0.00013012 |
| bmi-recompute     | 13/13 | 24.71s |            2 |   $0.00005149 |
| coffee-checkout   | 19/19 |  8.95s |            1 |   $0.00002335 |
| loan-comparison   | 18/18 | 60.49s |            8 |   $0.00032684 |
| todo-persistence  | 27/27 |  9.51s |            3 |   $0.00008366 |

The five live runs used **18 requests, 14654 input and 845 output tokens**, estimated **$0.00061547**. Replays add no model usage. Prices use returned Jev usage and the configured model rate ($0.042/M input, $0/M output, documentation snapshot 2026-10-17); these estimates are not invoices. No runtime writer was used.

## Honest first-attempt accounting

A first-attempt success means one frozen case version passed its first uninterrupted execution. A harness retry preserves the case and the failed report, but does not become a first-execution success. Zero prior DOM inspection, one authoring pass and zero model calls are different claims. Freeze timestamps and verified SHA-256 hashes are in the ledger and bundle.

| Initial target   | First execution | Coverage before stop |
| ---------------- | --------------- | -------------------- |
| TodoMVC React    | failed          | 18/19 observed steps |
| Coffee Cart      | blocked         | 0/1 observed steps   |
| BlazeDemo        | blocked         | 4/5 observed steps   |
| JPetStore        | blocked         | 2/3 observed steps   |
| DemoBlaze        | blocked         | 20/21 observed steps |
| BMI calculator   | blocked         | 6/7 observed steps   |
| TodoMVC transfer | passed          | 27/27 observed steps |
| Loan comparison  | passed          | 18/18 observed steps |

Two first executions passed: TodoMVC transfer (27 steps) and loan comparison (18 steps). TodoMVC's target DOM was not inspected before freezing, but the task pattern had already been attempted on React TodoMVC elsewhere; this is transfer with zero target inspection, not zero knowledge of TodoMVC. Loan comparison used one landing inspection, retained its displayed default ten-year term and independently calculated zero-interest payments, compound maturity and bond discount values. Neither case changed after the first run. Both passed a later independent live repeat.

Coffee Cart and BlazeDemo retained their original case bytes through harness fixes and passed fresh repeats. Coffee's preparation included a public client-source read to diagnose missing custom widgets: it is source-assisted, not a zero-shot discovery claim. BMI passed after a generic blocked-subframe fix. These are unchanged-prompt recoveries, with every earlier failure preserved.

## Generality audit and changes

- Removed menu-title prefix matching and an English new-window suffix shortcut from deterministic resolution. Only complete labels or declared aliases count as exact. Previously observed MuleSoft aliases now live in its example cases, not core logic.
- Kept one shared, opt-in `interaction` policy with bounded notice categories and per-category overrides, plus redacted `decisionContext` for domain vocabulary. Neither contains site URLs, provider branches or site selectors. The finite English/partial-Spanish notice catalog is not universal localization.
- Canonical atomic grammar avoids operation/literal calls, preserves apostrophes, variable-containing URLs and assertion polarity. Noncanonical prose uses Jev. Explicit name/role metadata constrains semantic disambiguation to matching controls; the confidence thresholds are unchanged.
- Observation handles clipped scroll targets, opacity-zero native checkbox proxies, alert dialogs, named DOM regions, nested custom pointer widgets and image-only links. The physical action still passes Playwright trial actionability. Native/declared modal dialogs exclude background controls; a nonmodal dialog does not hide an exposed external confirmation.
- Nearby scope uses named ancestor groups and preceding section headings. Field groups stop at form/semantic boundaries instead of importing unrelated sibling forms. Compact inspection keeps unnamed controls, placeholders and bounded native select options; full sanitized observations persist.
- Disallowed subframes stay blocked and logged without poisoning an unrelated main-page action. Main-page and popup origin restrictions still fail closed. No advertising origins were added.
- Late notice recovery repeats only a read-only assertion and preserves the original failure; it never repeats the preceding mutation. Native alerts and asynchronous server completion remain separate from DOM text.

These changes stay in shared parsing, observation, policy and execution boundaries. Introducing a per-site plugin hierarchy would add machinery without demonstrated benefit. Case-specific URLs, vocabulary, values and aliases remain in cases. The earlier AWS examples received observed aliases and schema validation; their private flows were not rerun during this public-site audit.

## Failures retained and limits

React TodoMVC did not retain tasks across reload in this run. JPetStore's `Click Angelfish` remained uncertain; thresholds were not lowered. DemoBlaze reached purchase confirmation in one attempt but could not resolve the final OK through the previous modal heuristic. A later faster run missed an asynchronously added cart item: a click does not prove a server mutation finished. This experimental case is retained in the bundle, excluded from passing examples and the live suite. No sleeps, automatic purchase retries or weakened assertions were added. GlobalsQA and Way2Automation returned HTTP 403/406 during availability checks; no cases ran there. A preliminary Coffee readiness assertion also failed because its exact text hypothesis did not match the rendered node; that report is included.

The two first-execution successes out of eight attempted cases are an observed sample, not a probability of success on arbitrary apps. New authentication, CAPTCHA, inaccessible networks, unknown fixtures and unsupported gestures can still require author input.

## Reproduce

```bash
npm ci
npx playwright install chromium
# Supply JEV_API_KEY through your environment.
npm run check
npm run build
npm test
npm run test:workflows
npm run test:public
# Or a single case:
node dist/cli.js run examples/public/coffee-checkout.en.json
node dist/cli.js replay artifacts/<successful-run>/replay.json
```

Use a test profile only where routine consent and draft discard are authorized. Fresh contexts prevent demo data from contaminating repeats. TodoMVC clears its created tasks; Coffee checkout clears its cart; BlazeDemo is a mock reservation; calculators have no account state. All contexts close after runs. Public availability and response time can change.

## Cost and author-model payloads

The ledger sums **all 35 reports in this audit**, including preparation, blocked authoring, recovery, repeatability, replay and old-corpus regression: **57 Jev requests**, estimated **$0.00227716**, usage complete: **true**. This is separate from the earlier MuleSoft task and from the calling author's LLM.

Using `o200k_base` on saved files: authoring skill **1737 tokens**, recovery skill **925**, schema **3297**. Case and inspection sizes are in the ledger. These are reproducible payload sizes, not measured GPT-6 API billing or a full session estimate. Repeated context, system/tool schemas, hidden reasoning and images are not metered here. DUIT cannot set an upper bound on another caller's authoring bill from these artifacts.

For an independent user's model, estimate input and output separately with `(inputTokens × inputRate + outputTokens × outputRate) / 1,000,000`. Read the authoring skill/schema once per setup, load recovery only when blocked, keep bounded inspections and reuse the validated case/replay. Zero-Jev replay does not imply zero browser or authoring cost.
