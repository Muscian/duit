# Real MuleSoft login

Duit completed a real login at `https://test1.platform.mulesoft.com/login/signin?`, using the test credentials supplied by the user, a fresh browser context, and Jev as the only runtime model. No cookies or storageState were imported, and the login was not replaced with a direct HTTP API call.

## Reproduced failure

Navigation returned HTTP 200 and the sign-in form loaded both directly and through the environment proxy. The original harness stopped at the first step with `NO_TARGET: No eligible DOM element exists for this step`.

The reproduced failure was a race with SPA rendering: `DOMContentLoaded` fired before Username and Password appeared. An empty snapshot was treated as definitive absence of the target. This could look like a connection problem in the previous report, which lacked network diagnostics.

The browser also only used a proxy when explicitly configured through `--proxy` or `DUIT_BROWSER_PROXY`. Although the Jev API could use HTTPS_PROXY, Chromium did not inherit that configuration from Duit. Direct connectivity works in the current environment; missing proxy inheritance was a concrete risk in environments that require it.

## Fixes

- The browser inherits standard HTTP_PROXY, HTTPS_PROXY, ALL_PROXY, and NO_PROXY settings. `--proxy` and `DUIT_BROWSER_PROXY` still take precedence; `--proxy direct` explicitly selects a direct connection. Proxy authentication is supported without exposing it in diagnostics.
- Before selecting a target, the adapter waits for controls compatible with the operation. It re-observes the DOM while the SPA loads; Jev decisions and actions with side effects are not retried.
- `--navigation-timeout` controls document navigation and control readiness (30 s by default). `--timeout` controls actions and assertions (5 s by default). This real scenario uses 60 s and 30 s respectively.
- HTML/JSON reports include the effective connection configuration, final URL, and up to 100 request failures, HTTP 4xx/5xx responses, and blocked navigation events. Proxy credentials, query strings, and fragments are stripped from diagnostic URLs.
- Initial HTTP failures, proxy failures, and missing rendered controls produce different errors: `HTTP_NAVIGATION_ERROR`, `BROWSER_CONNECTION_FAILED`, and `PAGE_NOT_READY`. Subresource HTTP failures are recorded as diagnostics; the pre-login 401 from `/accounts/api/profile` is normal and does not mean that sign-in failed.

## Reproducible case

```bash
npm ci
npx playwright install --with-deps chromium
cp .env.example .env
# Set JEV_API_KEY, MULESOFT_USERNAME, and MULESOFT_PASSWORD in .env.
# Existing environment variables take precedence.
npm run duit -- run examples/mulesoft-login.en.yaml --timeout 30000 --navigation-timeout 60000
```

The case has six steps: enter Username, enter Password, click Sign in, verify Management Center, verify API Manager, and verify that Sign in is no longer visible. Positive dashboard assertions prevent a pass based only on the form disappearing during a transition.

The CLI validation passed all six steps in **9.80 seconds**, with **9 Jev requests** and the proxy inherited automatically from the environment, without `--proxy`. The final URL was under `/home/organizations/`, and the screenshot showed the authenticated dashboard. That run's report is at `artifacts/mulesoft-login-final/report.html`, with details in `report.json`. Local artifacts are not versioned.

The opt-in regression also ran against the real site and passed from another fresh session in **10.90 seconds**, again with 9 Jev requests and inherited proxy. The **21 local tests** and all four previous live scenarios also passed with their expected results.

To repeat the opt-in regression:

```bash
npm run test:mulesoft
```

It requires the three variables above. Credentials are not stored in the case or the repository. This test checks all six steps, the authenticated route, and that the provider used real Jev. Local tests cover inherited proxy settings with a real HTTP proxy, NO_PROXY, delayed SPA controls, cancellation, and HTTP/proxy error diagnostics without requiring access to MuleSoft.
