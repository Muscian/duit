#!/usr/bin/env node
import "./load-env.js";
import { createInterface } from "node:readline";
import { HarnessSession } from "./core/session.js";
import { parseArgs } from "node:util";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadCase, resolveVariables } from "./core/input.js";
import { runCase } from "./core/runner.js";
import { parseReplay } from "./core/replay.js";
import { browserService, lazyJev } from "./services/browser-service.js";
import { lazyWriter } from "./providers/openai-content.js";
import { caseJsonSchema, validateCase } from "./core/authoring.js";
import { BrowserAdapter, type BrowserOptions } from "./platforms/browser.js";

const help = `duit — UI tests with Jev decisions and an optional field writer\n\n  npm run duit -- schema | validate case.yaml | serve | mcp\n  npm run duit -- run case.yaml [options]\n  npm run duit -- run steps.txt --base-url http://localhost:4173\n  npm run duit -- replay artifacts/<run>/replay.json [options]\n  npm run duit -- explore case.yaml [options]  # Retain browser after a blocked step\n\nOptions:\n  --visual              Enable experimental Jev screenshot click fallback\n  --max-requests N      Stop new Jev calls after this per-run limit\n  --max-cost-usd N      Stop new calls after reported spend reaches this estimate\n  --port N              Local API port (default 4318); DUIT_API_TOKEN sets bearer token\n  --base-url URL         Override starting URL (required for .txt/.md)\n  --out DIRECTORY       New artifact directory (must not already exist)\n  --browser NAME        chromium (default), firefox, webkit\n  --channel NAME        Chromium distribution: chrome, msedge, chromium (fresh session)\n  --allow-local-network-origin URL  Grant local-network access to this page origin; repeatable\n  --proxy URL           Override browser proxy; default inherits HTTP(S)_PROXY. Use "direct" to opt out\n  --headed              Show the browser\n  --timeout MS          Playwright action/assertion timeout (default 5000)\n  --navigation-timeout MS  Document and SPA readiness timeout (default 30000)\n  --budget MS           Whole-run deadline (default 300000)\n  --min-probability N    Decision threshold 0..1 (default 0.70)\n  --allow-origin URL    Allow additional navigation origin; repeatable\n  --storage-state FILE  Playwright authentication state\n  --trace               Record an unredacted Playwright trace (opt in)\n  --no-screenshots       Disable masked screenshots\n\nCorporate policy: DUIT_PRIVACY_MODE=restricted|local; DUIT_MODEL_ALLOWED_ORIGINS=origin,...\n\nExit codes: 0 passed, 1 assertion/action failed, 2 blocked/configuration error.\n`;
async function main() {
  const { values: v, positionals: p } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      visual: { type: "boolean" },
      "max-requests": { type: "string" },
      "max-cost-usd": { type: "string" },
      port: { type: "string" },
      "base-url": { type: "string" },
      out: { type: "string" },
      browser: { type: "string" },
      channel: { type: "string" },
      "allow-local-network-origin": { type: "string", multiple: true },
      proxy: { type: "string" },
      headed: { type: "boolean" },
      timeout: { type: "string" },
      budget: { type: "string" },
      "navigation-timeout": { type: "string" },
      "min-probability": { type: "string" },
      "allow-origin": { type: "string", multiple: true },
      "storage-state": { type: "string" },
      trace: { type: "boolean" },
      "no-screenshots": { type: "boolean" },
    },
  });
  if (v.help || !p.length) {
    console.log(help);
    return;
  }
  const [command, file] = p;
  if (command === "schema") {
    console.log(JSON.stringify(caseJsonSchema(), null, 2));
    return;
  }
  if (command === "serve" || command === "mcp") {
    const service = browserService(v.out);
    if (command === "serve") {
      const { startHttp } = await import("./services/http.js");
      const server = await startHttp(service, {
        port: v.port ? Number(v.port) : undefined,
        token: process.env.DUIT_API_TOKEN || undefined,
      });
      console.error(`DUIT API ${server.url}\nBearer token: ${server.token}`);
      const stop = () => {
        void server.close().then(() => process.exit(0));
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    } else {
      const { createMcpServer } = await import("./services/mcp.js");
      const { StdioServerTransport } =
        await import("@modelcontextprotocol/sdk/server/stdio.js");
      const server = createMcpServer(service);
      await server.connect(new StdioServerTransport());
      server.server.onclose = () => {
        void service.close();
      };
      const stop = () => {
        void service
          .close()
          .then(() => server.close())
          .then(() => process.exit(0));
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    }
    return;
  }
  if (command === "validate" && file) {
    console.log(
      JSON.stringify(
        validateCase(await loadCase(file, v["base-url"])),
        null,
        2,
      ),
    );
    return;
  }
  if (
    !["run", "replay", "explore"].includes(command) ||
    !file ||
    p.length !== 2
  )
    throw new Error(
      "Use run <case>, explore <case> or replay <plan>. See --help.",
    );
  const browser = v.browser ?? "chromium";
  if (!["chromium", "firefox", "webkit"].includes(browser))
    throw new Error("Invalid browser");
  if (
    v.channel &&
    (!["chrome", "msedge", "chromium"].includes(v.channel) ||
      browser !== "chromium")
  )
    throw new Error(
      "--channel must be chrome, msedge or chromium and requires --browser chromium",
    );
  const numeric = (raw: string | undefined, fallback: number) => {
    const n = raw === undefined ? fallback : Number(raw);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error("Timeout/budget must be positive");
    return n;
  };
  const replay =
    command === "replay"
      ? parseReplay(JSON.parse(await readFile(file, "utf8")))
      : undefined;
  const spec: import("./core/types.js").CaseSpec = replay
    ? {
        name: replay.name,
        baseUrl: v["base-url"] ?? replay.baseUrl,
        variables: replay.variables,
        browser: replay.browser,
        publicVariables: replay.publicVariables,
        steps: replay.actions.map((a) => a.text),
      }
    : await loadCase(file, v["base-url"]);
  const out = resolve(
    v.out ??
      join(
        "artifacts",
        new Date().toISOString().replace(/[:.]/g, "-") +
          "-" +
          randomUUID().slice(0, 8),
      ),
  );
  await mkdir(resolve(out, ".."), { recursive: true });
  if (v.visual) spec.visual = { ...spec.visual, enabled: true };
  if (v["max-requests"] || v["max-cost-usd"])
    spec.costs = {
      ...spec.costs,
      ...(v["max-requests"] ? { maxRequests: Number(v["max-requests"]) } : {}),
      ...(v["max-cost-usd"] ? { maxUsd: Number(v["max-cost-usd"]) } : {}),
    };
  const provider = replay ? undefined : lazyJev();
  const writer = !replay && spec.content?.enabled ? lazyWriter() : undefined;
  const platform = new BrowserAdapter({
    browser: browser as BrowserOptions["browser"],
    channel: (v.channel ?? spec.browser?.channel) as BrowserOptions["channel"],
    localNetworkOrigins:
      v["allow-local-network-origin"] ?? spec.browser?.localNetworkOrigins,
    headed: v.headed,
    proxy: v.proxy,
    timeoutMs: numeric(v.timeout, spec.browser?.timeoutMs ?? 5000),
    navigationTimeoutMs: numeric(
      v["navigation-timeout"],
      spec.browser?.navigationTimeoutMs ?? 30000,
    ),
    allowedOrigins: v["allow-origin"] ?? spec.browser?.allowedOrigins,
    storageState: v["storage-state"],
    tracePath: v.trace ? join(out, "trace.zip") : undefined,
    maskValues: [
      ...(spec.privacy?.redact ?? []),
      ...Object.entries(resolveVariables(spec.variables))
        .filter(([name]) => !spec.publicVariables?.includes(name))
        .map(([, value]) => value),
    ],
  });
  if (v.trace)
    console.log(
      "Trace enabled: DOM snapshots and network data may include secrets. Store artifacts privately.",
    );
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    if (command === "explore") {
      const session = new HarnessSession(spec, {
        provider: provider!,
        contentProvider: writer,
        platform,
        artifactsDir: out,
        signal: controller.signal,
        maxDurationMs: numeric(v.budget, 1800000),
        readinessTimeoutMs: numeric(
          v["navigation-timeout"],
          spec.browser?.navigationTimeoutMs ?? 30000,
        ),
        screenshots: !v["no-screenshots"],
        policy: v["min-probability"]
          ? { minProbability: Number(v["min-probability"]) }
          : undefined,
      });
      const show = (step: Awaited<ReturnType<HarnessSession["step"]>>) =>
        console.log(
          `${step.status.toUpperCase()} ${step.index + 1}. ${step.text}${step.error ? "\n" + step.error : ""}`,
        );
      try {
        await session.open();
        let cursor = 0;
        let plannedFailure: number | undefined;
        const continuePlan = async () => {
          if (
            plannedFailure !== undefined &&
            session.report.steps[plannedFailure].recoveredBy === undefined
          ) {
            throw new Error(
              "Resolve the blocked planned step with :retry or :confirm before :continue.",
            );
          }
          plannedFailure = undefined;
          while (cursor < spec.steps.length) {
            const result = await session.step(spec.steps[cursor++]);
            show(result);
            if (result.status !== "passed") {
              plannedFailure = result.index;
              break;
            }
          }
        };
        await continuePlan();
        console.log(
          "Session retained. Enter a natural-language step or JSON step. Commands: :inspect, :screenshot, :continue, :retry [replacement], :confirm <assertion>, :finish. Never repeat Apply after an uncertain result; inspect and confirm it.",
        );
        const input = createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: !!process.stdin.isTTY,
        });
        try {
          for await (const raw of input) {
            const line = raw.trim();
            if (!line) continue;
            if (line === ":finish") break;
            try {
              if (line === ":continue") await continuePlan();
              else if (line === ":inspect") {
                const o = await session.inspect();
                console.log(
                  JSON.stringify(
                    {
                      url: o.url,
                      title: o.title,
                      dialogs: o.dialogs,
                      text: o.text,
                      controls: o.elements
                        .filter((e) => e.visible && !e.occluded)
                        .map((e) => ({
                          role: e.role,
                          name: e.name,
                          context: e.context,
                          checked: e.checked,
                          disabled: e.disabled,
                          overlay: e.overlay,
                        })),
                    },
                    null,
                    2,
                  ),
                );
              } else if (line === ":screenshot")
                console.log(await session.capture());
              else if (line === ":retry" || line.startsWith(":retry ")) {
                const replacement = line.slice(7).trim();
                show(
                  await session.retry(
                    replacement.startsWith("{")
                      ? JSON.parse(replacement)
                      : replacement || undefined,
                  ),
                );
              } else if (line.startsWith(":confirm "))
                show(await session.confirm(line.slice(9).trim()));
              else
                show(
                  await session.step(
                    line.startsWith("{") ? JSON.parse(line) : line,
                  ),
                );
            } catch (error) {
              console.error(
                error instanceof Error ? error.message : String(error),
              );
            }
          }
        } finally {
          input.close();
        }
      } finally {
        const report = await session.close();
        console.log(
          `${report.status.toUpperCase()} · Jev: ${report.usage?.requests ?? 0} calls, estimated USD ${report.usage?.estimatedUsd?.toFixed(8) ?? "unknown"} · Writer: ${report.contentUsage?.requests ?? 0} calls, estimated USD ${(report.contentUsage?.estimatedUsd ?? 0).toFixed(8)} · Report: ${join(out, "report.html")}`,
        );
        process.exitCode = report.status === "passed" ? 0 : 2;
      }
      return;
    }
    const report = await runCase(spec, {
      provider,
      contentProvider: writer,
      platform,
      artifactsDir: out,
      replay,
      maxDurationMs: numeric(v.budget, 300000),
      readinessTimeoutMs: numeric(
        v["navigation-timeout"],
        spec.browser?.navigationTimeoutMs ?? 30000,
      ),
      policy: v["min-probability"]
        ? { minProbability: Number(v["min-probability"]) }
        : undefined,
      signal: controller.signal,
      screenshots: !v["no-screenshots"],
      onCleanupStep: (step) =>
        console.log(
          `CLEANUP ${step.status.toUpperCase()} ${step.index + 1}. ${step.text}${step.error ? "\n" + step.error : ""}`,
        ),
      onStep: (step) =>
        console.log(
          `${step.status.toUpperCase()} ${step.index + 1}. ${step.text}${step.error ? "\n" + step.error : ""}`,
        ),
    });
    console.log(
      `\n${report.status.toUpperCase()} · ${(report.durationMs / 1000).toFixed(2)}s · ${report.usage?.requests ?? report.decisions.length} Jev requests · estimated USD ${report.usage?.estimatedUsd?.toFixed(8) ?? "unknown"}\nReport: ${join(out, "report.html")}\nAgent report: ${join(out, "agent-report.json")}`,
    );
    if (report.contentUsage?.requests)
      console.log(
        `Writer: ${report.contentUsage.requests} calls · estimated USD ${report.contentUsage.estimatedUsd.toFixed(8)}${report.contentUsage.complete ? "" : " (incomplete usage)"}`,
      );
    if (report.error) console.error(report.error);
    for (const failure of report.agent?.failures ?? [])
      console.error(
        `${failure.code} [${failure.category}]: ${failure.nextAction}`,
      );
    process.exitCode =
      report.status === "passed" ? 0 : report.status === "failed" ? 1 : 2;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await provider?.close?.();
    await writer?.close?.();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Unexpected error");
  process.exitCode = 2;
});
