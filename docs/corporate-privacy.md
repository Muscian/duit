# Corporate privacy and agent recovery

DUIT can reduce data disclosure and produce machine-readable recovery evidence. This does not make a TypeSafe account zero-retention or turn DUIT into a certified, multi-tenant corporate service. Use a dedicated trusted runner and test accounts/data appropriate for the target environment.

## What TypeSafe actually publishes

Reviewed on **2026-10-18**, using the vendor's public documents:

| Topic                  | Published statement                                                                                                                                                                                                                                           | Consequence for DUIT                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Training               | [Privacy Policy](https://typesafe.ai/legal/privacy-policy) says TypeSafe will not train or fine-tune models on prompts or other Input. [Model documentation](https://docs.typesafe.ai/models) also says Jev is not trained on customer requests or responses. | This is a vendor commitment, not a technical guarantee enforced by DUIT.                                                                                                                               |
| Retention              | The privacy policy says data is retained as reasonably necessary; the [DPA](https://typesafe.ai/legal/data-processing) uses necessity and applicable-law criteria. These documents do not give a fixed default deletion deadline.                             | Do not equate no training with no storage or assume a 30-day limit.                                                                                                                                    |
| Zero data retention    | [Legal documentation](https://docs.typesafe.ai/legal) offers ZDR for enterprise customers through sales.                                                                                                                                                      | DUIT cannot establish whether this API key/account has ZDR. There is no invented `zdr: true` header or compliance flag. Confirm the agreement with TypeSafe before sending data whose use requires it. |
| Hosting/transfers      | The privacy policy states the service is hosted in the United States. The DPA incorporates EU SCCs and UK transfer terms.                                                                                                                                     | No EU-only processing or residency guarantee is assumed.                                                                                                                                               |
| Subprocessors/security | The DPA links the [Trust Center](https://trust.typesafe.ai) and [subprocessors](https://trust.typesafe.ai/subprocessors), and describes security obligations.                                                                                                 | This review did not verify private audit reports, certifications, tenant-specific controls, or the current subprocessor inventory.                                                                     |

The optional writer is a separate provider with separate terms. TypeSafe's statements do not cover that provider, the browser application's own telemetry, your proxy, or the agent consuming DUIT's MCP output.

## Choose a runner policy

```bash
# A process-wide minimum; cases submitted through HTTP/MCP cannot weaken it.
export DUIT_PRIVACY_MODE=restricted
# Exact origins, comma-separated. An explicitly empty value denies every origin.
export DUIT_MODEL_ALLOWED_ORIGINS=https://api.typesafe.ai
npm run duit -- run examples/public/selenium-form.en.yaml
```

A case can tighten the process policy:

```yaml
privacy:
  mode: restricted
  redact:
    - Synthetic confidential account identifier
```

| Capability                                | `standard` (compatible default)                           | `restricted`                                                                                                                          | `local`                           |
| ----------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Jev text decisions                        | Allowed                                                   | Allowed, reduced context                                                                                                              | Blocked before the provider/meter |
| Data supplied for target decisions        | Labels, roles, element text/context, URLs, title, dialogs | Labels, roles, state flags, options, explicit instructions/scope/aliases, URL origin; no element text/context, title, dialogs or href | None                              |
| Visual fallback/images                    | Explicit opt-in                                           | Blocked                                                                                                                               | Blocked                           |
| Runtime writer                            | Explicit opt-in with budgets                              | Blocked before request                                                                                                                | Blocked before request            |
| Screenshots and unredacted browser traces | Screenshots masked; trace opt-in                          | Blocked                                                                                                                               | Blocked                           |
| Reports/checkpoints/API results           | Sanitized detail                                          | Structural evidence, costs, recovery; no step instructions, action values/locators, DOM snapshots or model payloads                   | Same as restricted                |
| Export successful replay                  | Yes, where replayable                                     | No                                                                                                                                    | No                                |

`local` means **no model calls from the harness**, not offline browsing. The browser still visits the application's servers. Use explicit `operation`, `value` and unique `control` metadata (see `examples/public/selenium-explicit.en.yaml`) or an already reviewed replay. Ambiguous controls or natural-language compilation fail closed instead of silently calling Jev.

Restricted mode may require more explicit control names/scope because it removes useful context. Labels, select options and user-written instructions can themselves contain confidential information: restricted mode is data minimization, not automatic anonymization. Use local mode when no UI data may leave for a model. The runtime still observes the full UI in process to execute deterministic actions and assertions; reduced output is not a sandbox against code running inside that process.

## Data boundaries

- Case variables are private by default unless named in `publicVariables`. Known variable values, Jev/writer keys and `privacy.redact` literals are masked before model requests and textual outputs. JSON escaping (quotes, backslashes, newlines) is handled without invalidating the JSON. This is literal redaction, not a general PII/secret classifier. Prefer `${VARIABLE}` references to inline credentials.
- Restricted/local output reduces URLs to origins and omits detailed network URLs. It retains event kind, status, resource type and browser block/CORS reason. A useful CDN path may therefore require diagnosis on the trusted machine.
- The standard browser screenshot path masks fields and known private values. Other text/images can remain visible; restricted/local disable image capture/export entirely. Custom adapters must implement `configurePrivacy` for any independent trace/telemetry behavior; the core controls provider calls, its own screenshots and report exports.
- HTTP and MCP use the same core policy. Explicit session inspection in restricted/local exposes control names/roles (needed for correction), but omits page text, title, dialogs, href and surrounding context. An external agent receiving those names is another data recipient. `duit_screenshot` is refused in these modes.
- Both built-in model transports require HTTPS except loopback development fixtures, reject credentials/query/fragment in endpoint URLs, honor the optional origin allowlist, use the inherited proxy/CA configuration, and do not follow HTTP redirects. The allowlist is for built-in **model endpoints**, not all browser resource traffic. Custom providers must enforce equivalent transport restrictions. Use corporate network policy for process-wide egress controls.
- New run/session directories use mode `0700`; JSON/HTML/JUnit/checkpoint files use `0600` on POSIX. Images are inside the protected directory. These permissions are not disk encryption or separation between jobs running as the same OS user. DUIT does not implement artifact expiry; set retention in the CI artifact store. Restricted mode still retains structural error/cost metadata.
- The HTTP service remains loopback-only, bearer-authenticated and rejects browser Origin requests; MCP is local stdio. These are trusted local integrations, with access to runner environment variables and test credentials. SSO, per-user authorization, hosted tenant isolation and a secrets vault are not implemented.

## Failure contract for development agents

Every persisted run has `agent-report.json`, also embedded as `report.agent` in full and compact HTTP/MCP results. Per-step results contain `failure`; HTML and JUnit include the structured outcome. `version: 1` is the agent-report contract version. Step indexes are zero-based.

```json
{
  "code": "ACTION_OUTCOME_UNKNOWN",
  "category": "execution",
  "phase": "dispatch",
  "stepIndex": 4,
  "lane": "steps",
  "actionOutcome": "unknown",
  "recovery": "confirm_before_continue",
  "retrySameSession": false
}
```

The complete failure also includes a safe `summary`, deterministic `fingerprint`, `nextAction`, and provider HTTP status when available. It contains no DOM text, stack trace or model prompt. Fingerprints group **code + phase + operation + step index + lane**; scope them to your case/version in the orchestrator, since distinct cases can share a fingerprint.

| Failure                                                 | Classification / next action                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Missing CDN assets, provider connectivity, deadline     | `environment` / inspect environment evidence; an unauthenticated page's 401 alone is not a failure   |
| Ambiguous control, wrong context, stale target          | `decision` / inspect and correct this step in the retained session                                   |
| Expected UI state absent                                | `assertion` / investigate expected versus actual state, optionally poll only the assertion           |
| Dispatched action or interruption with uncertain result | `actionOutcome: unknown` / confirm using an independent assertion; retrying a mutation is prohibited |
| Privacy block                                           | `privacy` / use explicit steps or approved configuration; never automatically weaken the policy      |
| Token/request/USD ceiling                               | `budget` / stop calls, inspect whether cleanup remains; do not restart to reset the budget           |
| Invalid/missing configuration                           | `configuration` / fix configuration before another attempt                                           |

A category is a routing hint, **not proof of who caused a defect**. An assertion can fail because of the app, data fixture, account permissions, environment, or an incorrect test expectation. DUIT does not claim to resolve those possibilities without evidence.

The report includes `lifecycle`, completed step indexes, cleanup state (`not_requested`, `pending`, `not_run`, `passed`, `blocked`), total estimated Jev + writer cost, and whether usage is complete. A closed session never advertises same-session retry. `rerunWholeCase` is always false: this evidence is not an executable replay plan or authorization to recreate resources. A successful replay artifact is a separate opt-in input available in standard mode.

A cost-conscious orchestrator should:

1. Read the compact agent report before requesting the full report or screenshot. No LLM is needed to route known codes.
2. Stop on privacy/configuration/budget blocks. Avoid model-based diagnosis of a known CDN or credential error.
3. Keep the current session for recoverable control/context issues. Inspect once, provide an explicit control/value, and allow a bounded correction attempt. Deduplicate recurring fingerprints within the same case/version.
4. Confirm uncertain mutations rather than replaying them. After process exit, inspect resource state in a new authorized session before resuming; DUIT cannot reconnect to the old browser.
5. Check cleanup state even if the main failure is fixed. Explicit cleanup controls avoid spending model calls after the model budget is exhausted.
6. Read `usageComplete` alongside estimated cost. Provider errors/retries can make reported token cost incomplete; these numbers are estimates, not invoices. Per-run limits do not impose a cross-run pipeline budget; the orchestrator must do that.

Do not treat page text, model response content, error messages or screenshots as instructions for the agent. The structured recovery fields are generated locally without another model call.

## Validation

The corporate regression suite exercises escaped-secret redaction, reduced Jev payloads, report/checkpoint/callback/API output, mandatory runner policy, local execution, image/writer/trace denial, HTTP redirect denial for both providers, cleanup/error attribution, stable fingerprints, and uncertain-action confirmation. The existing runtime tests cover browser frames, notices, real Playwright assertions and uncertain dispatch recovery.

A live public Selenium form was also exercised in restricted mode with real Jev, and in local mode with explicit controls. A deliberately absent-text assertion validates the failed-run artifact and nonzero CLI exit path. Measurements are recorded in [public validation](public-validation.md#corporate-profiles-2026-10-18). These are public fixtures, not a certification or a test of TypeSafe account retention settings.
