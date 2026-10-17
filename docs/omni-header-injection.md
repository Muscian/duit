# Omni: open Header Injection, UI-only

Use `Governance Strategies → Add Strategy → Apply Policy`, search for Header Injection, and select the **Open: Works across all gateways** card. The catalogue also has a similarly named Omni/Mule Gateway policy; the example scopes the selection explicitly. The open flow maps the policy to the target vendor internally. Its review tooltip says: “Open policies are mapped to each vendor’s native implementation.” This is still the open flow; do not start creation from the provider-native policy catalogue.

## Run and adopt

```bash
# Set JEV_API_KEY, MULESOFT_USERNAME and MULESOFT_PASSWORD in .env.
export OMNI_API_NAME='OmniHeaderE2E-20261009-182322'
export OMNI_STAGE_ID='848506b2-b157-4758-b285-549a9967f0fe'
npm run duit -- explore examples/omni-header-injection.en.yaml --budget 3600000
```

The checked-in authoring case stops at **Review before applying**. It checks both headers, selects the exact stage checkbox (not the API's “Select all instances” checkbox), and asserts the one-instance summary and stage identity. Choose a disposable stage with no pre-existing header mapping before repeating a mutation: vendor mappings can share an operation-level identity rather than create an independently named resource.

Expected input:

- Inbound: `X-Backend-Source` = `duit-e2e`.
- Outbound: `X-Served-By` = `duit-test1`.
- Exactly one API stage.

This version of the open-policy wizard omits the Name & Description step. It does not let the author assign `DUIT Header Injection E2E <timestamp>`. Identify the run by its report, target instance, configured headers and activity row instead. The example must not claim that naming was tested.

After reviewing, continue in the retained session with `Click Apply policy` once. Navigate through `APIs`, the exact API, `Instances`, the exact instance, then `Activity log`. Check the `Applied (Open Flow)` activity's own status, not any unrelated “Completed” text elsewhere:

```json
{
  "instruction": "Verify the Completed status element is visible",
  "scope": "Header Mapping (1)"
}
```

Inspect `Policies` on that instance. Before removal, open `Edit configuration for Header Mapping GET /headers` and assert the configured request/response names to identify the mapping. Return with `Cancel`, open `More actions for Header Mapping`, and use `Remove Policy`. Inspect its confirmation and activity before proceeding; the exact final removal sequence and recorded result are below.

## Validation boundary

This case verifies browser-visible application, target, configuration and cleanup. It does not verify HTTP behavior, AWS integration type, AWS-15 conformance or AWS CLI credentials. The chosen fixture exposes `GET /headers` and an `Integration Mock` policy in the UI; that limitation does not establish a UI automation failure. Keep environment/fixture preflight separate when testing actual gateway behavior.

Jev is the only runtime model. All live interactions, including recovery and inspection, use DUIT's natural-language session. No manually supplied Playwright selector is used to navigate or operate the real UI. DUIT internally derives locators from observed DOM controls as part of its normal adapter.

## Full lifecycle case

`examples/omni-header-injection-lifecycle.en.yaml` checks the exact instance for an existing Header Mapping before creating anything, then adds Apply, instance activity and persisted configuration assertions, and UI cleanup. It changes the selected stage. Supply its exact instance route as well:

```bash
export OMNI_INSTANCE_PATH='/apis/awsapigw-8ukvcpo0ff/instances/848506b2-b157-4758-b285-549a9967f0fe'
npm run duit -- run examples/omni-header-injection-lifecycle.en.yaml --budget 1200000
```

The cleanup returns to that explicit instance, verifies both header names, removes Header Mapping through its menu and confirmation dialog, checks its absence, and checks `Aws Header Mapping → Removed → Completed` in the latest activity row. Other instance policies are left in place. Row scopes deliberately refer to the newest UI activity so an old successful run cannot satisfy the assertion. Run this scenario exclusively on its disposable stage; simultaneous operations on the same stage would invalidate that assumption.

The authoring run on 2026-10-17 completed application and cleanup using real Jev and Chromium. Its 54 recorded steps included one recovered transition failure, an `Applied (Open Flow)` activity with `Completed`, persisted request/response header-name assertions, Header Mapping absence after removal, and a `Removed` activity with `Completed`. No AWS API/CLI or HTTP fixture verification was performed.

Omni's Policies tab can retain its pre-application list even after the latest activity is `Completed`. The lifecycle case explicitly navigates to the same instance document after checking the activity to refresh that UI cache before verifying persisted configuration. In validation, a stale list blocked verification while cleanup's fresh navigation found the mapping and removed it successfully. No second Apply was sent to compensate for the stale list.

The activity tab also caches its list. The final case uses its **Refresh activity** button before asserting the newest row after both application and removal. A visible old Completed row is never used as evidence of the current removal.

The first navigation after “Switch to enhanced” waits for Omni's **Portfolio Overview**, not just its origin: the popup passes through an OAuth callback, and navigating before that callback finishes can interrupt login. This is a page-context precondition in the case, not a sleep or an authentication bypass.

Application/removal activities can remain `Running` until the view is refreshed. The final case gives the latest-row completion assertions a 120-second wait with the named **Refresh activity** button between unsuccessful observations. Repeated document reloads were observed keeping Omni in its Loading state, so the activity wait preserves the current view. It also waits for Header Mapping to appear before opening its configuration, so intermediate SPA renders do not consume target-decision attempts. These waits are assertions; Apply and Remove are never polled.

## Unattended validation result — 2026-10-17

The final fresh Chromium run (`omni-lifecycle-complete-2`, started at `17:49:30.843Z`) passed **all 46 main steps and all 13 cleanup steps** in **151.16 seconds**, with **74 Jev requests**, all using `jev-1.14.0`. It handled cookie consent, the email reminder, Agent Fabric welcome and the guided tour. No manual interaction, supplied selectors or additional runtime model was used.

The single selected target was stage `e2e` of `OmniHeaderE2E-20261009-182322`, instance `848506b2-b157-4758-b285-549a9967f0fe`. The run checked the one-instance review summary, `Applied (Open Flow) → Completed`, and all four persisted header field values. Cleanup verified the mapping identity, removed it, checked its absence and confirmed the latest `Aws Header Mapping → Removed → Completed` row. The removal assertion took two observations and exercised the named refresh control. The report had no warnings.

Validation also passed TypeScript checking, build, formatting, **40 local tests** (two separate live suites skipped by default), and the opt-in real-Jev demo suite, including its deliberately failing assertion. Earlier attempts exposed the documented cache and notice races; one passing lifecycle does not establish a statistical reliability guarantee. The wizard's missing name field and the UI-only fixture limitations above still apply.
