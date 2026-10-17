# Public UI validation — 2026-10-17

The final opt-in corpus passed all **7 scenarios / 30 steps** across three public sites designed for browser automation practice. Each scenario used a fresh Chromium context. All interactions ran through DUIT; no manually supplied Playwright selectors or external planning LLM were used. These demo flows do not create real accounts, purchase products or change external infrastructure.

| Case                                                                      | Challenge                                                             | Result |   Time | Jev calls | Estimated USD |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------ | -----: | --------: | ------------: |
| [selenium-form.en.yaml](../examples/public/selenium-form.en.yaml)         | Selenium: text, textarea, select, checkbox, submit                    | PASSED |  6.70s |         9 |   $0.00038417 |
| [dynamic-controls.en.yaml](../examples/public/dynamic-controls.en.yaml)   | The Internet: remove/add controls, delayed enabling, unlabelled input | PASSED | 14.42s |         6 |   $0.00027195 |
| [nested-frames.en.yaml](../examples/public/nested-frames.en.yaml)         | The Internet: nested frames                                           | PASSED |  2.66s |         5 |   $0.00016666 |
| [popup.en.yaml](../examples/public/popup.en.yaml)                         | The Internet: new-window transition                                   | PASSED |  4.20s |         2 |   $0.00007157 |
| [text-input.en.yaml](../examples/public/text-input.en.yaml)               | UI Testing Playground: changing button label                          | PASSED |  3.00s |         4 |   $0.00013570 |
| [selenium-visual.en.yaml](../examples/public/selenium-visual.en.yaml)     | Selenium: real Jev image presence + Box click                         | PASSED |  5.17s |         5 |   $0.00029450 |
| [selenium-explicit.en.yaml](../examples/public/selenium-explicit.en.yaml) | Selenium: explicit semantic contracts, no model                       | PASSED |  3.24s |         0 |   $0.00000000 |

Total: **31,537 input tokens, 31 Jev calls, estimated $0.00132455**. This is measured model usage for this corpus, not an account invoice or a statistical reliability claim. The explicit case is shorter than the natural-language form case; timings are illustrative, not a controlled performance comparison.

The provider responses identified `jev-1.14.0`. Sites: [Selenium form](https://www.selenium.dev/selenium/web/web-form.html), [The Internet](https://the-internet.herokuapp.com), [UI Testing Playground](https://uitestingplayground.com/textinput).

## Additional checks

- Automatic screenshot fallback on the local [canvas demo](../examples/canvas/case.en.yaml), whose button has no DOM control: PASSED with real Jev, three calls including compilation, estimated $0.00020223. Presence and box were evaluated in one image request. A deterministic page-text assertion verified the click result.
- Real stdio MCP client → DUIT session → public Selenium form → inspect/fill/submit/assert/close: PASSED, four steps, zero model calls. The MCP client needed to propagate this environment's proxy variables; a launcher omitting those variables correctly failed with connection diagnostics. The service did not bypass the proxy.
- Real authenticated HTTP API → asynchronous public Selenium run → status polling: PASSED, four steps, zero model calls.
- Runtime writer: local tests exercised the OpenAI-compatible HTTP contract, budgets, generated fill, nonempty assertion and replay without another writer request. `${...}` in generated text stayed literal. A real external generative LLM was **not** called: no writer credentials were configured. Configure `DUIT_WRITER_*` and actual model prices before running [runtime-writing.en.yaml](../examples/public/runtime-writing.en.yaml).
- Local coverage includes HTTP bearer/origin checks, MCP tool calls, a non-browser fake adapter, missing visual targets, stale screenshots, invalid box geometry, model budgets, incomplete/unknown pricing and writer overspend. These checks complement the existing browser/network/recovery suite.

Earlier public attempts found and reproduced two runtime problems. A late popup could make a text assertion continue reading the old page; polling now follows the current adopted page. Jev could reject the sole unnamed text input when its expected value appeared in the instruction; exact generic field phrases now bind a single compatible field deterministically. Multiple candidates still require disambiguation.

Local verification passed **48 tests** (three opt-in live suites skipped by the default command), TypeScript checking, build and formatting. The separate real-Jev demo suite also passed, including its deliberately false assertion.

## Reproduce

```bash
npm ci
npx playwright install chromium
# Configure JEV_API_KEY in the environment or repository .env.
npm run test:public

# Optional real image fallback without any DOM control:
npm run demo:canvas
# In another terminal:
npm run duit -- run examples/canvas/case.en.yaml
```

`test:public` is opt-in because it uses the network and bills Jev. The default test command skips public/live suites. Reports, masked screenshots, usage and eligible replay plans are stored in a new `artifacts/public-suite-*/` directory. A public site changing or becoming unavailable is a reportable result, not permission to weaken assertions. Visual targeting remains experimental and viewport-bound; these successes do not establish coverage for arbitrary poorly described tasks, inaccessible environments or hidden controls.
