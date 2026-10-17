import test from "node:test";
import assert from "node:assert/strict";
import { loadCase, resolveVariables } from "../src/core/input.js";
import { JevProvider } from "../src/providers/jev.js";
import { BrowserAdapter } from "../src/platforms/browser.js";
import { runCase } from "../src/core/runner.js";

test(
  "MuleSoft real login: environment proxy, delayed SPA, and authenticated dashboard",
  {
    skip: process.env.DUIT_MULESOFT_LIVE !== "1",
    timeout: 150000,
  },
  async () => {
    for (const name of [
      "JEV_API_KEY",
      "MULESOFT_USERNAME",
      "MULESOFT_PASSWORD",
    ])
      assert(
        process.env[name],
        `Set ${name} for the opt-in MuleSoft login test`,
      );
    const spec = await loadCase("examples/mulesoft-login.en.yaml");
    const provider = new JevProvider();
    try {
      const report = await runCase(spec, {
        provider,
        platform: new BrowserAdapter({
          timeoutMs: 30000,
          navigationTimeoutMs: 60000,
          maskValues: Object.values(resolveVariables(spec.variables)),
        }),
        maxDurationMs: 120000,
      });
      console.log(
        JSON.stringify({
          name: report.name,
          status: report.status,
          durationMs: report.durationMs,
          requests: report.decisions.length,
          connection: report.diagnostics?.connection,
          artifactsDir: report.artifactsDir,
        }),
      );
      assert.equal(
        report.status,
        "passed",
        report.error ?? report.steps.find((s) => s.error)?.error,
      );
      assert.equal(report.steps.length, 6);
      assert.match(report.diagnostics?.url ?? "", /\/home\/organizations\//);
      assert(report.decisions.length > 0);
      assert(
        report.decisions.every((d) => d.response.model.startsWith("jev-")),
      );
    } finally {
      await provider.close();
    }
  },
);
