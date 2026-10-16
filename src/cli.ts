#!/usr/bin/env node
import "./load-env.js";
import { parseArgs } from "node:util";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadCase, resolveVariables } from "./core/input.js";
import { runCase } from "./core/runner.js";
import { parseReplay } from "./core/replay.js";
import { JevProvider } from "./providers/jev.js";
import { BrowserAdapter, type BrowserOptions } from "./platforms/browser.js";

const help = `duit — natural-language UI tests powered only by Jev\n\n  npm run duit -- run case.yaml [options]\n  npm run duit -- run steps.txt --base-url http://localhost:4173\n  npm run duit -- replay artifacts/<run>/replay.json [options]\n\nOptions:\n  --base-url URL         Override starting URL (required for .txt/.md)\n  --out DIRECTORY       New artifact directory (must not already exist)\n  --browser NAME        chromium (default), firefox, webkit\n  --proxy URL           Browser HTTP proxy (or DUIT_BROWSER_PROXY)\n  --headed              Show the browser\n  --timeout MS          Playwright action/assertion timeout (default 5000)\n  --budget MS           Whole-run deadline (default 300000)\n  --min-probability N    Decision threshold 0..1 (default 0.70)\n  --allow-origin URL    Allow additional navigation origin; repeatable\n  --storage-state FILE  Playwright authentication state\n  --trace               Record an unredacted Playwright trace (opt in)\n  --no-screenshots       Disable masked screenshots\n\nExit codes: 0 passed, 1 assertion/action failed, 2 blocked/configuration error.\n`;
async function main() {
  const { values: v, positionals: p } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      "base-url": { type: "string" },
      out: { type: "string" },
      browser: { type: "string" },
      proxy: { type: "string" },
      headed: { type: "boolean" },
      timeout: { type: "string" },
      budget: { type: "string" },
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
  if (!["run", "replay"].includes(command) || !file || p.length !== 2)
    throw new Error("Use run <case> or replay <plan>. See --help.");
  const browser = v.browser ?? "chromium";
  if (!["chromium", "firefox", "webkit"].includes(browser))
    throw new Error("Invalid browser");
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
  const spec = replay
    ? {
        name: replay.name,
        baseUrl: v["base-url"] ?? replay.baseUrl,
        variables: replay.variables,
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
  const provider = replay ? undefined : new JevProvider();
  const platform = new BrowserAdapter({
    browser: browser as BrowserOptions["browser"],
    headed: v.headed,
    proxy: v.proxy,
    timeoutMs: numeric(v.timeout, 5000),
    allowedOrigins: v["allow-origin"],
    storageState: v["storage-state"],
    tracePath: v.trace ? join(out, "trace.zip") : undefined,
    maskValues: Object.values(resolveVariables(spec.variables)),
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
    const report = await runCase(spec, {
      provider,
      platform,
      artifactsDir: out,
      replay,
      maxDurationMs: numeric(v.budget, 300000),
      policy: v["min-probability"]
        ? { minProbability: Number(v["min-probability"]) }
        : undefined,
      signal: controller.signal,
      screenshots: !v["no-screenshots"],
      onStep: (step) =>
        console.log(
          `${step.status.toUpperCase()} ${step.index + 1}. ${step.text}${step.error ? "\n" + step.error : ""}`,
        ),
    });
    console.log(
      `\n${report.status.toUpperCase()} · ${(report.durationMs / 1000).toFixed(2)}s · ${report.decisions.length} Jev requests\nReport: ${join(out, "report.html")}`,
    );
    if (report.error) console.error(report.error);
    process.exitCode =
      report.status === "passed" ? 0 : report.status === "failed" ? 1 : 2;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await provider?.close();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Unexpected error");
  process.exitCode = 2;
});
