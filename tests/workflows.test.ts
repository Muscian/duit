import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadCase } from "../src/core/input.js";
import { parseReplay } from "../src/core/replay.js";
import { runCase } from "../src/core/runner.js";
import { BrowserAdapter } from "../src/platforms/browser.js";
import { lazyJev } from "../src/services/browser-service.js";

const root = join("artifacts", `public-workflows-${Date.now()}`);
for (const file of [
  "coffee-checkout.en.json",
  "blaze-reservation.en.json",
  "bmi-recompute.en.json",
  "todo-persistence.en.json",
  "loan-comparison.en.json",
]) {
  test(
    `public workflow: ${file}`,
    { skip: process.env.DUIT_WORKFLOW_LIVE !== "1", timeout: 300000 },
    async () => {
      const spec = await loadCase(join("examples/public", file));
      const provider = lazyJev();
      const out = join(root, file.replace(".en.json", ""));
      try {
        const report = await runCase(spec, {
          provider,
          platform: new BrowserAdapter(spec.browser),
          artifactsDir: out,
          maxDurationMs: 180000,
        });
        console.log(
          JSON.stringify({
            file,
            status: report.status,
            steps: report.steps.length,
            ms: report.durationMs,
            usage: report.usage,
            artifacts: out,
          }),
        );
        assert.equal(
          report.status,
          "passed",
          report.steps.find((s) => s.error)?.error ?? report.error,
        );
        if (file.startsWith("coffee") || file.startsWith("todo")) {
          const replay = parseReplay(
            JSON.parse(await readFile(join(out, "replay.json"), "utf8")),
          );
          const repeated = await runCase(spec, {
            replay,
            platform: new BrowserAdapter(spec.browser),
            artifactsDir: `${out}-replay`,
            maxDurationMs: 180000,
          });
          console.log(
            JSON.stringify({
              file,
              mode: "replay",
              status: repeated.status,
              steps: repeated.steps.length,
              ms: repeated.durationMs,
              usage: repeated.usage,
              artifacts: `${out}-replay`,
            }),
          );
          assert.equal(
            repeated.status,
            "passed",
            repeated.steps.find((s) => s.error)?.error ?? repeated.error,
          );
          assert.equal(repeated.decisions.length, 0);
        }
      } finally {
        await provider.close?.();
      }
    },
  );
}
