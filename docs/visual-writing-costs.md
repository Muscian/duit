# Visual targeting, optional writing and model cost

## Visual fallback

Jev `jev-1.14.0` supports PNG/JPEG and normalized Box outputs. TypeSafe labels this capability experimental (“Dreamer-ready”); DUIT pins the model and sends the required `TypeSafe-Danger-Zone-Images: true` header. References: [Box](https://docs.typesafe.ai/primitives/box), [images](https://docs.typesafe.ai/images).

```yaml
visual:
  enabled: true
  maxCalls: 3
  minProbability: 0.9
  minConfidence: 0.6
steps:
  - Click Continue
  - instruction: Click the Submit button
    visual: only
  - Verify the text "Received!" is visible
```

Or pass `--visual`. DOM targeting runs first unless a click explicitly says `visual: only`. A missing/ambiguous DOM decision can fall back to the masked viewport. One image request asks both whether exactly one enabled, unobstructed target matches and for its box. Box alone always returns coordinates, even when a target is absent; DUIT never trusts Box without the presence gate. API errors, context mismatches and uncertain dispatched actions do not trigger another click through the fallback.

The adapter validates normalized bounds and dimensions, rejects oversized boxes, and compares a hash of the masked viewport, URL, scroll and viewport size immediately before dispatch. If the view changed, it blocks. It clicks the box center once. This is conservative and can block on animations; it cannot eliminate a change occurring between the last check and the physical click. Presence/confidence is model evidence, not a guarantee of correctness.

Current scope: clicks in the current viewport only; no visual typing, drag/drop, autonomous scrolling, CAPTCHA solving or visual assertion judge. Unknown/ambiguous goals remain blocked. Form fields and configured private variables are masked before transmission. The rest of the visible page is sent to Jev: enable this only for an appropriate test environment. Images must be 280–1568 CSS pixels on both axes (default viewport 1280×800).

Reports include visual decisions, boxes, confidence, usage and the exact masked viewport PNG used for the decision (unless screenshots are disabled). Image bytes are not embedded in report JSON or text decision prompts. Runs with visual actions do not export replay because coordinates belong to one snapshot. DOM-only replay remains model-free.

Try `npx tsx examples/canvas/server.ts`, then `npm run duit -- run examples/canvas/case.en.yaml`. The canvas has no DOM control for its drawn button; this exercises automatic fallback, not only an explicitly forced image click.

## Author once, or generate field text in runtime

Cheapest/reproducible path: let the user's authoring model write `value` once. Explicit operations and unique observed `control` contracts avoid Jev classification, literal and target calls:

```yaml
- instruction: Write the test note
  operation: fill
  control: { name: Textarea }
  value: Synthetic note prepared during authoring.
```

Natural-language steps remain supported, and a case can mix both forms. Explicit operation/value metadata is authoritative; its prose should describe the same operation. A unique name/role match binds directly. Repeated exact names constrain Jev to those matching controls; missing explicit names never select a different label. `assert_nonempty` measures non-whitespace field content; it does not evaluate whether generated prose is correct.

For optional runtime generation, configure an OpenAI-compatible **chat completions** writer:

```bash
export DUIT_WRITER_ENDPOINT='https://your-provider.example/v1/chat/completions'
export DUIT_WRITER_MODEL='your-model'
export DUIT_WRITER_API_KEY='your-key'
```

```yaml
content:
  enabled: true
  maxRequests: 2
  maxUsd: 0.01
  inputPerMillion: 1 # Example only: replace with the actual writer rate.
  outputPerMillion: 4
  maxOutputTokens: 100
steps:
  - instruction: Write a synthetic note
    operation: fill
    control: { name: Textarea }
    generate:
      prompt: Write one short sentence about a fictional calendar app. No personal data.
      maxChars: 120
  - instruction: Verify the note is populated
    operation: assert_nonempty
    control: { name: Textarea }
```

Generation is allowed only for `fill` and cannot be combined with `value`. It runs after resolving/preparing the field and before mutation. The writer sees only the explicit, secret-redacted prompt; it receives no DOM, screenshot, tools or control over actions. Empty/oversized output or an exceeded response budget blocks the fill. Requests are not automatically retried. Identical sanitized prompt/maxChars pairs are cached within the run. Recorded replay uses the generated text as a literal, including any `${...}` characters; it never reruns the writer or interprets generated text as another action. Reports/replay can therefore contain the generated prose.

The adapter supports providers returning `choices[].message.content` and token `usage` from chat completions; it is not a universal LLM protocol adapter. Inject another `ContentProvider` through the TypeScript API for other protocols. Caller-configured prices must match the actual writer model. No writer credentials are bundled.

## Cost accounting and limits

Every report includes Jev request count, input/output tokens, estimated USD, price source and whether usage is incomplete. Optional writer usage/cost is reported separately. HTML and CLI show Jev cost; JSON records both providers. Fully explicit and replay runs report zero model use.

At validation on 2026-10-17, [TypeSafe's published rate](https://docs.typesafe.ai/models) for `jev-1.13.0` and `jev-1.14.0` was **$0.042 per million input tokens**, with free output. DUIT uses returned token usage, including image requests. For other models it reports unknown cost unless both `inputPerMillion` and `outputPerMillion` overrides are configured. These are estimates, not the account invoice; transport failures/retries without returned usage, account credits and contract discounts cannot be reconstructed.

```yaml
costs:
  maxRequests: 30
  maxInputTokens: 100000
  maxUsd: 0.01
```

CLI equivalents: `--max-requests 30 --max-cost-usd 0.01`. Limits stop the **next** logical model call after the reported amount reaches the limit. An in-flight request can exceed a token/USD threshold; they are not a provider-side hard billing cap. A request-count limit counts logical decisions, not internal HTTP retries. Writer response overspend is recorded and blocks filling. A failed request marks usage incomplete.

Budget exhaustion or cancellation may prevent model-dependent cleanup. Prefer explicit cleanup controls/values for critical resources, inspect the report and resource state, and do not restart a mutation blindly. Use replay or explicit contracts after authoring to minimize repeat cost. Large broad prompts, screenshots and unscoped control lists usually cost more than precise observed names and compact scenarios.
