import test from "node:test";
import assert from "node:assert/strict";
import { join, basename } from "node:path";
import { loadCase, resolveVariables } from "../src/core/input.js";
import { runCase } from "../src/core/runner.js";
import { BrowserAdapter } from "../src/platforms/browser.js";
import { lazyJev } from "../src/services/browser-service.js";

test(
  "public UI corpus: natural language, dynamic controls, frames, popup, visual and zero-model contract",
  { skip: process.env.DUIT_PUBLIC_LIVE !== "1", timeout: 900000 },
  async () => {
    const root = join("artifacts", `public-suite-${Date.now()}`);
    for (const file of [
      "selenium-form.en.yaml",
      "dynamic-controls.en.yaml",
      "nested-frames.en.yaml",
      "popup.en.yaml",
      "text-input.en.yaml",
      "selenium-visual.en.yaml",
      "selenium-explicit.en.yaml",
    ]) {
      const spec = await loadCase(join("examples/public", file)),
        provider = lazyJev();
      try {
        const report = await runCase(spec, {
          provider,
          platform: new BrowserAdapter({
            ...spec.browser,
            maskValues: Object.values(resolveVariables(spec.variables)),
          }),
          maxDurationMs: 180000,
          artifactsDir: join(root, basename(file, ".yaml")),
        });
        console.log(
          JSON.stringify({
            file,
            status: report.status,
            ms: report.durationMs,
            usage: report.usage,
            visualCalls: report.visualDecisions?.length,
            artifacts: report.artifactsDir,
          }),
        );
        assert.equal(
          report.status,
          "passed",
          report.steps.find((s) => s.error)?.error ?? report.error,
        );
        if (file.includes("explicit")) assert.equal(report.usage?.requests, 0);
        if (file.includes("visual"))
          assert.equal(report.visualDecisions?.length, 1);
      } finally {
        await provider.close?.();
      }
    }
  },
);
