import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type RequestListener } from "node:http";
import { runCase } from "../src/core/runner.js";
import { HarnessSession } from "../src/core/session.js";
import { redactor } from "../src/core/input.js";
import { resolvePrivacy, checkModelEndpoint } from "../src/core/privacy.js";
import { describeFailure } from "../src/core/failures.js";
import { JevProvider } from "../src/providers/jev.js";
import { OpenAIContentProvider } from "../src/providers/openai-content.js";
import { BrowserAdapter } from "../src/platforms/browser.js";
import { summarize } from "../src/services/service.js";
import {
  HarnessError,
  type CaseSpec,
  type DecisionProvider,
  type Observation,
  type PlatformAdapter,
  type ResolvedAction,
} from "../src/core/types.js";

const confidential = 'client "A"\\private\nline two';
const noModel: DecisionProvider = {
  async decide() {
    throw new Error("Unexpected model call");
  },
};
class Fixture implements PlatformAdapter {
  prepare?: PlatformAdapter["prepare"];
  observeVisual?: PlatformAdapter["observeVisual"];
  captures = 0;
  actions: ResolvedAction[] = [];
  fail = false;
  async open() {}
  async close() {}
  async capture() {
    this.captures++;
  }
  async observe(): Promise<Observation> {
    return {
      url: "https://example.test/private/customer?token=secret",
      title: "Private customer account",
      text: confidential,
      elements: ["Continue", "Cancel"].map((name, i) => ({
        id: `e${i}`,
        tag: "button",
        role: "button",
        name,
        text: confidential,
        context: "Confidential surrounding customer content",
        type: "",
        visible: true,
        disabled: false,
        locator: { frame: 0, kind: "role", value: "button", name },
      })),
    };
  }
  async execute(a: ResolvedAction) {
    this.actions.push(a);
    if (this.fail) throw new Error(`Unexpected UI state: ${confidential}`);
  }
}
function spec(
  mode: "standard" | "restricted" | "local" = "restricted",
): CaseSpec {
  return {
    name: "Corporate case",
    baseUrl: "https://example.test",
    variables: { secret: confidential },
    privacy: { mode },
    steps: [
      {
        instruction: "Click Continue",
        operation: "click",
        control: { name: "Continue", role: "button" },
      },
      {
        instruction: "Verify success",
        operation: "assert_text",
        value: "Success",
      },
    ],
  };
}
async function out(name: string) {
  return join(await mkdtemp(join(tmpdir(), "duit-corporate-")), name);
}
async function endpoint(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("redaction handles escaped secrets, valid JSON, and minimizes URLs without modifying actions", () => {
  const clean = redactor({ secret: confidential, numeric: "123" }, [], true);
  assert.equal(clean("123"), "[REDACTED]");
  assert.equal(
    redactor({ secret: confidential })(encodeURIComponent(confidential)),
    "[REDACTED]",
  );
  assert.deepEqual(
    JSON.parse(
      clean(
        JSON.stringify({
          text: confidential,
          url: "https://host.test/customer?token=abc#s",
        }),
      ),
    ),
    { text: "[REDACTED]", url: "https://host.test" },
  );
  assert.equal(clean(`private ${confidential}`), "private [REDACTED]");
});

test("restricted requests omit DOM context; report, callbacks, checkpoints and API summaries omit sensitive evidence", async () => {
  const platform = new Fixture();
  let calls = 0,
    progress = "";
  const provider: DecisionProvider = {
    async decide(state, questions) {
      calls++;
      const payload = JSON.stringify({ state, questions });
      assert.ok(!payload.includes("Confidential surrounding"));
      assert.ok(!payload.includes("Private customer"));
      assert.ok(!payload.includes("token="));
      assert.ok(!payload.includes("client"));
      assert.ok(payload.includes("Continue"));
      return {
        model: "jev-1.14.0",
        answers: {
          target: {
            type: "choice",
            choice: "e0",
            confidence: 1,
            probabilities: { e0: 1, e1: 0, none: 0 },
          },
        },
        usage: { input_tokens: 100, output_tokens: 0 },
      };
    },
  };
  const input = spec();
  input.steps[0] = {
    instruction: "Activate the primary progression control",
    operation: "click",
  };
  const report = await runCase(input, {
    platform,
    provider,
    artifactsDir: await out("restricted"),
    onStep: (r) => {
      progress += JSON.stringify(r);
    },
  });
  assert.equal(report.status, "passed");
  assert.equal(calls, 1);
  assert.equal(platform.captures, 0);
  assert.equal(report.decisions[0].request, undefined);
  if (process.platform !== "win32") {
    assert.equal((await stat(report.artifactsDir)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(report.artifactsDir, "report.json"))).mode & 0o777,
      0o600,
    );
  }
  assert.equal(report.steps[0].action?.target, undefined);
  assert.equal(report.steps[0].failure, undefined);
  assert.ok(report.agent?.usageComplete);
  assert.equal(summarize(report).agent?.rerunWholeCase, false);
  assert.ok(!progress.includes("Continue"));
  const files = await readdir(report.artifactsDir);
  assert.ok(!files.includes("replay.json"));
  for (const file of files) {
    const contents = await readFile(join(report.artifactsDir, file), "utf8");
    assert.ok(!contents.includes("token="), file);
    assert.ok(!contents.includes("private/customer"), file);
    assert.ok(!contents.includes("Continue"), file);
  }
});

test("local mode executes explicit controls with zero calls and blocks natural compilation before opening", async () => {
  const platform = new Fixture();
  const report = await runCase(spec("local"), {
    provider: noModel,
    platform,
    artifactsDir: await out("explicit"),
  });
  assert.equal(report.status, "passed");
  assert.equal(report.usage?.requests, 0);
  const input = spec("local");
  input.steps = ["Click Continue", "Verify Success"];
  const blocked = await runCase(input, {
    provider: noModel,
    platform,
    artifactsDir: await out("natural"),
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.agent?.failures[0].code, "PRIVACY_POLICY_BLOCKED");
  assert.equal(blocked.agent?.failures[0].category, "privacy");
  assert.equal(blocked.usage?.requests, 0);
});

test("mandatory runner privacy cannot be relaxed by a case; endpoint allowlist fails closed", () => {
  const previous = process.env.DUIT_PRIVACY_MODE,
    origins = process.env.DUIT_MODEL_ALLOWED_ORIGINS;
  try {
    process.env.DUIT_PRIVACY_MODE = "local";
    assert.equal(resolvePrivacy({ mode: "standard" }).mode, "local");
    process.env.DUIT_PRIVACY_MODE = "typo";
    assert.throws(() => resolvePrivacy(), /INVALID_PRIVACY_POLICY/);
    process.env.DUIT_MODEL_ALLOWED_ORIGINS = "https://api.typesafe.ai";
    checkModelEndpoint("https://api.typesafe.ai/v1/systemone");
    assert.throws(
      () => checkModelEndpoint("https://unapproved.test/api"),
      /PRIVACY_POLICY_BLOCKED/,
    );
    assert.throws(
      () => checkModelEndpoint("https://api.typesafe.ai/api?secret=x"),
      /INVALID_ENDPOINT/,
    );
    process.env.DUIT_MODEL_ALLOWED_ORIGINS = "";
    assert.throws(
      () => checkModelEndpoint("https://api.typesafe.ai/api"),
      /PRIVACY_POLICY_BLOCKED/,
    );
  } finally {
    if (previous === undefined) delete process.env.DUIT_PRIVACY_MODE;
    else process.env.DUIT_PRIVACY_MODE = previous;
    if (origins === undefined) delete process.env.DUIT_MODEL_ALLOWED_ORIGINS;
    else process.env.DUIT_MODEL_ALLOWED_ORIGINS = origins;
  }
});

test("restricted sessions prohibit image export and visual requests, minimize inspection and preserve uncertainty", async () => {
  const platform = new Fixture();
  const input = spec();
  input.visual = { enabled: true };
  let images = 0;
  const session = new HarnessSession(input, {
    platform,
    provider: {
      ...noModel,
      async locate() {
        images++;
        throw new Error("Unexpected image");
      },
    },
    artifactsDir: await out("session"),
  });
  await session.open();
  const observed = await platform.observe();
  platform.observe = async () => observed;
  assert.equal((await session.inspect()).text, undefined);
  assert.equal(observed.text, confidential);
  await assert.rejects(session.capture(), /PRIVACY_POLICY_BLOCKED/);
  platform.fail = true;
  const result = await session.step(input.steps[0]);
  assert.equal(result.failure?.actionOutcome, "unknown");
  assert.equal(result.failure?.retrySameSession, false);
  await assert.rejects(session.retry(), /ACTION_OUTCOME_UNKNOWN/);
  platform.fail = false;
  await session.confirm(input.steps[1]);
  const closed = await session.close();
  assert.equal(closed.status, "passed");
  assert.equal(closed.agent?.failures.length, 0);
  assert.equal(images, 0);
  assert.equal(platform.captures, 0);
});

test("restricted visual and writer branches are blocked without provider calls or usage", async () => {
  const platform = new Fixture();
  const input = spec();
  input.steps[0] = {
    instruction: "Write sample",
    operation: "fill",
    control: { name: "Input" },
    generate: { prompt: "Sample" },
  };
  platform.observe = async () => ({
    url: "https://example.test",
    title: "",
    elements: [
      {
        id: "e0",
        tag: "input",
        role: "textbox",
        name: "Input",
        text: "",
        type: "text",
        context: "",
        disabled: false,
        visible: true,
        locator: { frame: 0, kind: "label", value: "Input" },
      },
    ],
  });
  input.content = {
    enabled: true,
    maxRequests: 1,
    maxUsd: 1,
    inputPerMillion: 1,
    outputPerMillion: 1,
  };
  const report = await runCase(input, {
    platform,
    provider: noModel,
    contentProvider: {
      async generate() {
        throw new Error("Writer must not be called");
      },
    },
    artifactsDir: await out("writer"),
  });
  assert.equal(report.agent?.failures[0].code, "PRIVACY_POLICY_BLOCKED");
  assert.equal(report.contentUsage?.requests, 0);
  assert.equal(platform.actions.length, 0);
});

test("restricted visual fallback is blocked before image upload or screenshot persistence", async () => {
  const platform = new Fixture();
  platform.observeVisual = async () => ({
    format: "png",
    dataBase64: "unused",
    width: 1000,
    height: 800,
    revision: "fixture",
  });
  const input = spec();
  input.visual = { enabled: true };
  input.steps[0] = {
    instruction: "Click Continue",
    operation: "click",
    visual: "only",
  };
  let images = 0;
  const report = await runCase(input, {
    platform,
    provider: {
      ...noModel,
      async locate() {
        images++;
        throw new Error("Unexpected upload");
      },
    },
    artifactsDir: await out("images"),
  });
  assert.equal(report.agent?.failures[0].code, "PRIVACY_POLICY_BLOCKED");
  assert.equal(images, 0);
  assert.equal(platform.captures, 0);
  assert.equal(report.usage?.requests, 0);
  assert.ok(
    (await readdir(report.artifactsDir)).every((f) => !f.endsWith(".png")),
  );
});

test("agent report attributes assertion vs environment vs cleanup failure; fingerprints exclude error content", async () => {
  const platform = new Fixture();
  platform.execute = async (a) => {
    if (a.operation === "assert_text")
      throw new Error("actual account A versus B");
  };
  const input = spec();
  input.steps = [input.steps[1]];
  input.cleanup = [
    { instruction: "Verify clean", operation: "assert_text", value: "Clean" },
  ];
  const report = await runCase(input, {
    platform,
    provider: noModel,
    artifactsDir: await out("failures"),
  });
  assert.equal(report.status, "failed");
  assert.equal(report.agent?.failures.length, 2);
  assert.equal(report.agent?.cleanup, "blocked");
  assert.equal(report.agent?.failures[0].code, "ASSERTION_FAILED");
  assert.equal(report.agent?.failures[0].retrySameSession, false);
  assert.equal(report.agent?.failures[1].lane, "cleanup");
  assert.deepEqual(
    JSON.parse(
      await readFile(join(report.artifactsDir, "agent-report.json"), "utf8"),
    ),
    report.agent,
  );
  const failure = describeFailure("JEV_HTTP_ERROR: Jev API returned HTTP 429");
  assert.equal(failure.category, "environment");
  assert.equal(failure.providerStatus, 429);
  assert.equal(
    describeFailure("NO_TARGET: Account A").fingerprint,
    describeFailure("NO_TARGET: Account B").fingerprint,
  );
  assert.equal(
    describeFailure("PAGE_RESOURCES_FAILED: CDN failed").recovery,
    "fix_environment",
  );
  assert.equal(
    describeFailure("MODEL_BUDGET_EXCEEDED: cap").recovery,
    "stop_budget",
  );
});

test("Jev and writer never forward prompts or bearer tokens across HTTP redirects", async () => {
  let sinkRequests = 0,
    sourceRequests = 0;
  const sink = await endpoint((_req, res) => {
    sinkRequests++;
    res.end("unexpected");
  });
  const source = await endpoint((req, res) => {
    sourceRequests++;
    req.resume();
    res.writeHead(307, { location: sink.url });
    res.end();
  });
  const jev = new JevProvider({
    endpoint: source.url,
    apiKey: "fake",
    retries: 0,
  });
  const writer = new OpenAIContentProvider({
    endpoint: source.url,
    apiKey: "fake",
    model: "fixture",
  });
  try {
    await assert.rejects(
      jev.decide({ private: "fixture" }, {}),
      /JEV_HTTP_ERROR/,
    );
    await assert.rejects(
      writer.generate("private prompt", 10),
      /CONTENT_HTTP_ERROR/,
    );
    assert.equal(sourceRequests, 2);
    assert.equal(sinkRequests, 0);
    const previous = process.env.DUIT_PRIVACY_MODE;
    try {
      process.env.DUIT_PRIVACY_MODE = "local";
      await assert.rejects(jev.decide({}, {}), /PRIVACY_POLICY_BLOCKED/);
      await assert.rejects(
        writer.generate("private", 10),
        /PRIVACY_POLICY_BLOCKED/,
      );
      assert.equal(sourceRequests, 2);
    } finally {
      if (previous === undefined) delete process.env.DUIT_PRIVACY_MODE;
      else process.env.DUIT_PRIVACY_MODE = previous;
    }
  } finally {
    await jev.close();
    await writer.close();
    await source.close();
    await sink.close();
  }
});

test("restricted browser rejects trace recording before starting Chromium", async () => {
  const platform = new BrowserAdapter({ tracePath: "/not-created.zip" });
  const report = await runCase(spec(), {
    platform,
    provider: noModel,
    artifactsDir: await out("trace"),
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.agent?.failures[0].code, "PRIVACY_POLICY_BLOCKED");
});

test("uncertain interruption actions also require confirmation before retry", async () => {
  const platform = new Fixture();
  const session = new HarnessSession(spec(), {
    platform,
    provider: noModel,
    artifactsDir: await out("interruption"),
  });
  await session.open();
  // Reproduce an adapter's uncertain late overlay action during target preparation.
  platform.prepare = async () => {
    throw new HarnessError(
      "ACTION_OUTCOME_UNKNOWN",
      "Overlay click may have completed",
    );
  };
  const failed = await session.step(spec().steps[0]);
  assert.equal(failed.phase, "prepare");
  assert.equal(failed.failure?.recovery, "confirm_before_continue");
  await assert.rejects(session.retry(), /ACTION_OUTCOME_UNKNOWN/);
  await session.close(false);
});
