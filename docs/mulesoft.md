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

## macOS, VPN, and a blank sign-in page

The later macOS report is a different failure from the SPA race: the document loads, but `styles.889a3c08.css` and `lib.889a3c08.js` on `cdn.test1.mulesoft-cp2.test1-uswest2.aws.sfdc.cl` fail with `net::ERR_FAILED`. Increasing the timeout cannot restore a download that Chromium has blocked. A successful curl request also does not establish that browser permissions/CORS allow the same resource.

`ERR_FAILED` alone does not identify the cause. On recent Chromium, a public page reaching an address classified as local/loopback needs local-network permission. VPN or split DNS can make a corporate CDN resolve to such an address. Existing browser profiles may already have this permission; DUIT's isolated contexts start without it. This possibility was reproduced locally with real Chromium: scripts/styles failed with `ERR_FAILED` and CDP reported `LocalNetworkAccessPermissionDenied`; an origin-scoped grant restored the rendered form. It remains a hypothesis for the affected Mac until its report contains that reason.

Update dependencies/browser and run with a grant for the requesting sign-in page:

```bash
npm ci
npx playwright install chromium
npm run duit -- run examples/mulesoft-login.en.yaml \
  --allow-local-network-origin https://test1.platform.mulesoft.com \
  --timeout 30000 --navigation-timeout 60000
```

The option grants `local-network-access` before navigation. It targets the **requesting page origin**, not the CDN origin, and grants access only for this fresh context. It does not import cookies or authentication state. It does not create VPN access, modify DNS, or grant macOS application-level network permissions. If Omni is the starting URL and redirects to this different origin, include `--allow-origin https://test1.platform.mulesoft.com` too; permission origins must be the starting origin or an explicitly allowed navigation origin.

To compare browser distributions, append `--channel chrome --headed`. Chrome must already be installed. This still uses a fresh context; a successful login in your personal profile is not evidence that the isolated context can load the assets. The default remains Playwright Chromium. Unsupported permission grants produce `LOCAL_NETWORK_PERMISSION_UNSUPPORTED` with update guidance.

The HTML report's **Connection and network diagnostics** section, also in `report.json`, now includes browser name/version/channel, granted origins, resource types, and Chromium protocol error details:

| Evidence                                                              | Next check                                                                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `corsError: LocalNetworkAccessPermissionDenied`                       | Use the scoped permission above; check application-level Local Network permission in macOS if it persists.                                      |
| Another `corsError`, e.g. `MissingAllowOriginHeader`                  | Inspect CDN CORS headers, redirects and any VPN/proxy response. A local-network grant cannot fix missing CORS headers.                          |
| `blockedReason: csp` or `mixed-content`                               | Inspect the page's content security policy and asset scheme.                                                                                    |
| `ERR_CERT_*`, `ERR_NAME_NOT_RESOLVED`, `ERR_TUNNEL_CONNECTION_FAILED` | Check browser certificate trust, VPN/DNS, and proxy reachability respectively. Node's CA configuration alone does not configure Chromium trust. |
| HTTP 403/407/5xx on a script/stylesheet                               | Check CDN/proxy access and service health.                                                                                                      |
| HTTP 401 on `/accounts/api/profile` before login                      | Expected; this alone does not block the test.                                                                                                   |

CDP details are available for Chromium distributions. Firefox/WebKit retain Playwright request/HTTP diagnostics. The diagnostics remain bounded and omit credentials, query strings, fragments, headers, bodies, and arbitrary console messages.

A blank document with failed main-frame scripts/styles now produces `PAGE_RESOURCES_FAILED` with status `blocked`, instead of claiming that the expected text is incorrect. A negative assertion cannot pass just because the broken page is empty. Missing controls after the SPA readiness deadline also include asset failures. Optional asset failures on a rendered page stay diagnostic and do not turn every assertion into an infrastructure failure. A successful reload clears active asset failures while retaining the event history.

Local regressions cover real local-network denial and recovery, origin scope, ordinary CORS denial, HTTP asset failures, positive/negative text assertions on blank pages, and successful reloads. These tests run offline against local HTTP servers and use no model.

Validation on 2026-10-17: all **25 local tests** passed (the two opt-in live suites were skipped by `npm test`); type checking, build, and formatting passed. The separate `npm run test:mulesoft` execution, now granting the sign-in origin permission in a fresh Chromium context, passed all six steps in **10.37 seconds** with **9 real Jev requests** and reached `/home/organizations/`. The affected Mac was not accessible from this environment; its precise cause still requires its new protocol diagnostics.
