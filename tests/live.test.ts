import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startShop } from "../examples/shop/server.js";
import { JevProvider } from "../src/providers/jev.js";
import { BrowserAdapter } from "../src/platforms/browser.js";
import { runCase } from "../src/core/runner.js";
import { parseCase } from "../src/core/input.js";

test(
  "live Jev-only: checkout ES, login EN, incorrect credentials and a deliberately false assertion",
  { skip: process.env.DUIT_LIVE !== "1", timeout: 180000 },
  async () => {
    assert(
      process.env.JEV_API_KEY,
      "Set JEV_API_KEY; live tests never silently fall back to mocks",
    );
    const shop = await startShop(0),
      provider = new JevProvider(),
      root = await mkdtemp(join(tmpdir(), "duit-live-"));
    try {
      const checkout = parseCase(
        await readFile("examples/checkout.es.yaml", "utf8"),
        { baseUrl: shop.url },
      );
      checkout.variables.PASSWORD = "demo123";
      const english = parseCase(
        await readFile("examples/login.en.txt", "utf8"),
        { baseUrl: shop.url, plainText: true, name: "English login" },
      );
      const invalid = parseCase(
        await readFile("examples/invalid-login.es.yaml", "utf8"),
        { baseUrl: shop.url },
      );
      const falseAssertion = {
        ...english,
        name: "False assertion",
        steps: [
          ...english.steps,
          'Verify the text "Order totally impossible" is visible',
        ],
      };
      for (const [i, spec] of [
        checkout,
        english,
        invalid,
        falseAssertion,
      ].entries()) {
        const report = await runCase(spec, {
          provider,
          platform: new BrowserAdapter({
            timeoutMs: 1200,
            maskValues: Object.values(spec.variables),
          }),
          artifactsDir: join(root, String(i)),
          screenshots: false,
        });
        console.log(
          JSON.stringify({
            name: spec.name,
            status: report.status,
            ms: report.durationMs,
            requests: report.decisions.length,
            tokens: report.decisions.reduce(
              (n, d) => n + d.response.usage.input_tokens,
              0,
            ),
            error: report.error ?? report.steps.find((s) => s.error)?.error,
          }),
        );
        assert.equal(report.status, i === 3 ? "failed" : "passed");
        assert(
          report.decisions.every((d) => d.response.model.startsWith("jev-")),
        );
      }
    } finally {
      await provider.close();
      await shop.close();
    }
  },
);
