# API, MCP and authoring skills

Build with `npm ci && npm run build`. Node 22+ and Playwright browsers are required. The TypeScript API remains available from `dist/index.js`. Core orchestration depends on `PlatformAdapter`, `DecisionProvider` and optional `ContentProvider`; `PlatformRegistry` maps a case's `platform` (default `browser`) to an adapter factory. HTTP and MCP use the same `DuitService` lifecycle. A fake non-browser adapter is exercised through both transports in local tests; mobile/native adapters are not implemented.

## MCP

Use the compiled entrypoint directly: npm writes non-protocol output to stdout.

```json
{
  "mcpServers": {
    "duit": {
      "command": "node",
      "args": ["/absolute/path/to/duit/dist/cli.js", "mcp"],
      "env": { "JEV_API_KEY": "YOUR_KEY" }
    }
  }
}
```

Supply keys through your client's secret mechanism instead of committing them. Some MCP launchers filter inherited environment variables; behind a proxy/VPN, explicitly propagate `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and the configured CA environment (such as `NODE_EXTRA_CA_CERTS`) as needed. DUIT also reads the repository `.env`. Fully explicit operation/value/control cases can run without a Jev key: the provider initializes lazily.

Tools: `duit_schema`, `duit_validate`, `duit_materialize`, `duit_run`, `duit_run_status`, `duit_cancel`, `duit_session_open`, `duit_inspect`, `duit_screenshot`, `duit_step`, `duit_retry`, `duit_confirm`, `duit_session_close`. The `duit://case-schema` resource exposes the same JSON Schema. Tool results return compact summaries by default; request run `details` only when decision evidence is needed. Screenshot output is explicit and masked.

A session opens the starting page but does **not** execute `case.steps`; send steps individually. The runtime retains the page on a blocked step, and rejects concurrent session operations. Cleanup runs on session close. Idle sessions expire after 10 minutes; sessions also have a 30-minute overall deadline. Batch runs default to 5 minutes. The service defaults to four active runs/sessions and retains at most 100 completed run summaries in memory. Artifacts are persisted under `artifacts/service` (or `--out`); metadata is not restored after a server restart.

## Local HTTP API

```bash
# Optional stable bearer token; otherwise one is generated and printed to stderr.
export DUIT_API_TOKEN='replace-with-a-long-random-local-token'
node dist/cli.js serve --port 4318
```

The server binds only to `127.0.0.1`, requires its bearer token for every route, rejects requests carrying a browser Origin, limits bodies to 1 MiB and does not expose arbitrary artifact files. This is a trusted local automation service, not a hosted multi-user service. Authorized clients can navigate apps and use configured environment credentials. Do not publish it through an unauthenticated tunnel.

| Method and route                  | Input/result                                                             |
| --------------------------------- | ------------------------------------------------------------------------ |
| `GET /v1/health`                  | Adapter capabilities                                                     |
| `GET /v1/schema`                  | JSON Schema                                                              |
| `POST /v1/validate`               | Case → errors/hints, no model/browser                                    |
| `POST /v1/materialize`            | `{case, fields:[{step:1,value:"..."}]}` → case with concrete fill values |
| `POST /v1/runs`                   | Case → `202 {id,state}`                                                  |
| `GET /v1/runs/:id`                | Progress, then compact redacted report; `?details=true` for full report  |
| `POST /v1/runs/:id/cancel`        | Abort and close; cleanup may not run                                     |
| `POST /v1/sessions`               | Case → retained session ID and inspection                                |
| `GET /v1/sessions/:id/inspect`    | URL, text, controls and usage                                            |
| `GET /v1/sessions/:id/screenshot` | `{mimeType,data}` with masked PNG base64                                 |
| `POST /v1/sessions/:id/steps`     | `{step}` → step result                                                   |
| `POST /v1/sessions/:id/retry`     | Optional `{step}` correcting pre-dispatch failure                        |
| `POST /v1/sessions/:id/confirm`   | `{step}` assertion verifying uncertain dispatch                          |
| `POST /v1/sessions/:id/close`     | Cleanup and final report                                                 |

The HTTP API accepts JSON cases; YAML files can be parsed with `loadCase` or converted by the authoring client. Example:

```bash
node dist/cli.js schema > case.schema.json
node dist/cli.js validate examples/public/selenium-explicit.en.yaml
```

## Skills for the user's model

Install the directories `skills/duit-authoring` and `skills/duit-recovery` in the skill location supported by your coding agent (for Codex, copy them into `~/.codex/skills/`). They teach the model to inspect unfamiliar apps through MCP, draft reproducible field values, validate cases, minimize model calls and recover without duplicating changes. They do not add another model to DUIT's runtime.

A calling LLM can draft a `fill` value directly, or call `duit_materialize`. A separate runtime writer is available only when explicitly configured; see [visual targeting, writing and costs](visual-writing-costs.md).

## Corporate policy and compact failure output

Set `DUIT_PRIVACY_MODE=restricted` (or `local`) in the service/MCP process environment; submitted cases cannot weaken it. Add `DUIT_MODEL_ALLOWED_ORIGINS` for built-in provider egress. HTTP/MCP run summaries include `agent` and `privacy`; individual step results include a stable `failure` object. Read those before fetching full evidence. See [corporate privacy](corporate-privacy.md) for the contract, policy matrix and account-retention limitations.
