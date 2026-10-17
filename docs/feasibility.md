# Feasibility: Jev as the only model at runtime

This records the original Jev-only evaluation. The default runtime still uses Jev for decisions; version 0.2 also offers an explicitly enabled, separately budgeted field writer. See [current capabilities and boundaries](visual-writing-costs.md).

Validation was performed on **October 16, 2026** with Node.js 24, Chromium/Playwright, and the pinned **`jev-1.14.0`** model. The credential used was `JEV_API_KEY`; the official API returned HTTP 200. No other LLM was involved in harness runs.

## Result

**This is viable for DOM UI flows with atomic steps, explicit data, and concrete assertions.** Evidence includes a local shop with real controls and states, a complete checkout on the public SauceDemo demo site, and replay without a model. It does not demonstrate a universal agent that can turn any open-ended goal into a correct test.

The fundamental limit is that Jev chooses among alternatives; it does not generate strings, code, or open-ended plans. The harness supplies that alternative set deterministically: an action catalog, values copied from the instruction, and observed elements. Playwright handles execution and result checking.

## Observed runs

These figures are measurements from individual validation runs, **not a statistical benchmark**, percentiles, or an SLA. Time includes browser and network; screenshots were enabled for CLI runs and disabled in the live suite.

| Scenario                                            | Result              | Steps |    Time | Jev requests | Input tokens |
| --------------------------------------------------- | ------------------- | ----: | ------: | -----------: | -----------: |
| Local purchase in Spanish, final live suite         | Passed              |    14 | 7.073 s |           20 |       18,366 |
| Login with English instructions and exact UI labels | Passed              |     4 | 2.005 s |            7 |        4,972 |
| Incorrect credentials, expected error visible       | Passed              |     4 | 1.955 s |            7 |        5,000 |
| Deliberately false assertion after login            | Failed, as expected |     5 | 3.223 s |            8 |        5,831 |
| Public SauceDemo, final checkout with screenshots   | Passed              |    15 | 13.82 s |           22 |       21,563 |
| Local checkout replay                               | Passed              |    14 |  1.56 s |            0 |            0 |
| Public SauceDemo replay with `JEV_API_KEY` unset    | Passed              |    15 |  7.71 s |            0 |            0 |

On SauceDemo, the public test user signed in, selected **Sauce Labs Backpack** from products with “Add to cart” buttons, checked the cart, and completed the demo purchase. The application was not modified or instrumented by the harness. The environment's HTTP proxy was used for the browser, with TLS enabled.

JSON reports include the version returned by the API, token usage, probabilities, candidates, and selected actions. Run artifacts are excluded from Git by default; scenarios and tests are versioned in the working tree.

## Findings that shaped the design

1. **Question wording matters.** After the observed context changed, the initial question assigned p=0.60 to the exact “Sign in” button, correctly blocking the step. Three formulations were compared on the same state: p=0.61, p=0.84, and p=0.95. The third was adopted; it explicitly identifies `state.step` as the instruction and the criteria as data. The four local scenarios and public checkout then passed again. Thresholds were not lowered and decision retries were not added to force a success.
2. **Cross-language equivalence is not universal.** “Click the sign in button” versus “Iniciar sesión” produced decisions without sufficient confidence. The reproducible example uses `Click the "Iniciar sesión" button`. No translator or other LLM was added. English and Spanish instructions work in the verified scenarios; other paraphrases need evaluation.
3. **An executed action does not prove the goal.** At least one assertion is required, and Playwright checks each one. The negative case confirmed that missing text results in failure, even if the preceding login passed.
4. **Replay removes decisions from the stable path.** Both checkouts replayed without requests to Jev; the external run also worked with `JEV_API_KEY` removed from the process. This allows a case to be reviewed/resolved live and then used in CI.
5. **Accuracy depends on the candidate set.** If an element was not observed, a value is not in the step, or the instruction is ambiguous, the system should block. A high threshold cannot fix an incomplete candidate list.

## Engineering checks

- `npm run check`: library, CLI, tests, and example types.
- `npm run build`: ESM distribution and TypeScript declarations.
- `npm test`: **21 tests passed**, including real Chromium execution; the live suite is intentionally skipped here.
- `npm run test:live`: **4 scenarios against real Jev** in one integration test; three positive cases and one expected failure.
- `npm run test:mulesoft`: real login with a fresh context, inherited proxy, and six passing steps; see [MuleSoft](mulesoft.md) for diagnosis and results.
- Protocol: rejects invented choices, invalid distributions, missing responses, low confidence, unsupported operations, and invalid replay plans.
- Transport: checks bounded retries for 429, no retries for 401, and cancellation without exposing error bodies or credentials.
- Browser: forms, selection, checks, enabled/disabled state, async assertions, screenshots, open shadow DOM, and iframes.
- Runner: resource cleanup, missing variables, missing assertions, cancellation during execution/capture, and no successful replay after a failure.

Automated tests use Chromium. Firefox/WebKit are available as adapter options but **were not run** in this validation. The GitHub Actions workflow was not run remotely.

## What remains before claiming product reliability

A corpus of the user's applications and cases, with labeled intent and targets, is needed. Relevant metrics include correct operation and target, value acceptance, blocked rate, false-positive assertions, stability under DOM changes, latency, and cost per case. Evaluation should include ambiguous instructions, multiple languages, real errors, and duplicate elements, not only successful flows.

This proof of concept provides the evaluation infrastructure and a working demonstration of the hypothesis. Interpretation remains probabilistic; even a deterministic assertion can target the wrong element if the step was misinterpreted. Reports and replay make that decision reviewable. For canvas, open-ended goals, data that must be invented, long-term planning, or inaccessible UIs, the current design needs more code/candidates or an explicit expansion of scope.

## Jev contract sources

- [Official API](https://docs.typesafe.ai/api): `POST /v1/systemone`, state, questions, and typed responses.
- [Choice](https://docs.typesafe.ai/primitives/choice): selections and probability distributions; 255 options maximum.
- [Pre-parsed value extraction](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook): code finds candidates, Jev chooses, and code copies the value.
- [Models](https://docs.typesafe.ai/models): versions, context limits, and language limitations.
- [Confidence](https://docs.typesafe.ai/confidence): relationship between probability and confidence; neither is a guarantee of correctness.
