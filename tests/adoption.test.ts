import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserAdapter } from "../src/platforms/browser.js";
import { runCase } from "../src/core/runner.js";
import { MeteredProvider } from "../src/core/metering.js";
import { materializeFields } from "../src/core/authoring.js";
import { FieldWriter } from "../src/core/content.js";
import { JevProvider } from "../src/providers/jev.js";
import { DuitService, PlatformRegistry } from "../src/services/service.js";
import { startHttp } from "../src/services/http.js";
import { createMcpServer } from "../src/services/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  CaseSpec,
  DecisionProvider,
  VisualResponse,
  ResolvedAction,
} from "../src/core/types.js";

async function endpoint(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
const noModel: DecisionProvider = {
  async decide() {
    throw new Error("Unexpected model call");
  },
};
const visualResponse: VisualResponse = {
  model: "jev-1.14.0",
  usage: { input_tokens: 1000, output_tokens: 20 },
  answers: {
    presence: {
      type: "choice",
      choice: "one",
      confidence: 1,
      probabilities: { one: 1, none: 0, several: 0 },
    },
    target: {
      type: "box",
      box: {
        left: 38 / 1280,
        right: 238 / 1280,
        top: 48 / 800,
        bottom: 128 / 800,
      },
      confidence: 0.99,
    },
  },
};
const canvas = `<canvas width="400" height="180"></canvas><p>Ready</p><script>document.querySelector('canvas').addEventListener('click',()=>document.querySelector('p').textContent='Selected');const c=document.querySelector('canvas').getContext('2d');c.fillStyle='#1764cd';c.fillRect(30,40,200,80);c.font='24px sans-serif';c.fillStyle='white';c.fillText('Continue',70,90)</script>`;
const steps: CaseSpec["steps"] = [
  { instruction: "Click Continue", operation: "click" },
  {
    instruction: "Verify Selected",
    operation: "assert_text",
    value: "Selected",
  },
];

test("visual fallback clicks an unlabelled canvas, meters usage, and refuses stale replay", async () => {
  const app = await endpoint((_q, r) => {
    r.setHeader("content-type", "text/html");
    r.end(canvas);
  });
  const root = await mkdtemp(join(tmpdir(), "duit-visual-"));
  let calls = 0;
  try {
    const report = await runCase(
      {
        name: "Canvas",
        baseUrl: app.url,
        variables: {},
        visual: { enabled: true },
        steps,
      },
      {
        provider: {
          ...noModel,
          async locate(frame) {
            calls++;
            assert(frame.dataBase64.length > 100);
            return visualResponse;
          },
        },
        platform: new BrowserAdapter({ proxy: "direct", timeoutMs: 500 }),
        artifactsDir: root + "/run",
      },
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(calls, 1);
    assert.equal(report.steps[0].action?.resolution, "jev-box");
    assert.equal(report.usage?.estimatedUsd, 0.000042);
    assert.equal(report.usage?.requests, 1);
    await assert.rejects(access(root + "/run/replay.json"));
    assert(!JSON.stringify(report).includes("dataBase64"));
    assert.match(
      await readFile(root + "/run/report.html", "utf8"),
      /Estimated USD/,
    );
  } finally {
    await app.close();
  }
});

test("absent visual target never clicks and changed frame invalidates coordinates", async () => {
  const app = await endpoint((_q, r) => {
    r.setHeader("content-type", "text/html");
    r.end(canvas);
  });
  const root = await mkdtemp(join(tmpdir(), "duit-visual-stop-"));
  try {
    const report = await runCase(
      {
        name: "Missing",
        baseUrl: app.url,
        variables: {},
        visual: { enabled: true },
        steps,
      },
      {
        provider: {
          ...noModel,
          async locate() {
            return {
              ...visualResponse,
              answers: {
                ...visualResponse.answers,
                presence: {
                  type: "choice",
                  choice: "none",
                  confidence: 1,
                  probabilities: { one: 0, none: 1, several: 0 },
                },
              },
            };
          },
        },
        platform: new BrowserAdapter({ proxy: "direct", timeoutMs: 200 }),
        artifactsDir: root + "/run",
        screenshots: false,
      },
    );
    assert.equal(report.status, "blocked");
    assert.match(report.steps[0].error!, /UNCERTAIN_VISUAL_TARGET/);
    const browser = new BrowserAdapter({ proxy: "direct" });
    try {
      await browser.open(app.url);
      const frame = await browser.observeVisual();
      const action: ResolvedAction = {
        text: "Click Continue",
        operation: "click",
        visualTarget: {
          ...frame,
          box: visualResponse.answers.target.box,
          confidence: 1,
          presenceProbability: 1,
        },
      };
      await browser.execute(action);
      await assert.rejects(
        () => browser.execute(action),
        /VISUAL_FRAME_CHANGED/,
      );
    } finally {
      await browser.close();
    }
  } finally {
    await app.close();
  }
});

test("Jev image transport uses explicit image header and validates normalized boxes", async () => {
  let bad = false;
  const app = await endpoint((q, r) => {
    let body = "";
    q.on("data", (c) => (body += c));
    q.on("end", () => {
      const request = JSON.parse(body);
      assert.equal(q.headers["typesafe-danger-zone-images"], "true");
      assert.equal(
        request.assets[request.state.screenshot].data_base64,
        "YWJj",
      );
      r.setHeader("content-type", "application/json");
      r.end(
        JSON.stringify(
          bad
            ? {
                ...visualResponse,
                answers: {
                  ...visualResponse.answers,
                  target: {
                    ...visualResponse.answers.target,
                    box: { left: 1, right: 0, top: 0, bottom: 1 },
                  },
                },
              }
            : visualResponse,
        ),
      );
    });
  });
  const p = new JevProvider({ endpoint: app.url, apiKey: "test", retries: 0 });
  const frame = {
    format: "png" as const,
    dataBase64: "YWJj",
    width: 1280,
    height: 800,
    revision: "test",
  };
  try {
    assert.equal(
      (await p.locate(frame, "Continue")).answers.target.type,
      "box",
    );
    bad = true;
    await assert.rejects(
      () => p.locate(frame, "Continue"),
      /INVALID_MODEL_RESPONSE/,
    );
  } finally {
    await p.close();
    await app.close();
  }
});

test("cost budgets stop further calls; unknown models and failed calls are not priced as zero", async () => {
  let calls = 0;
  const provider: DecisionProvider = {
    async decide() {
      calls++;
      return {
        model: "jev-1.14.0",
        answers: {},
        usage: { input_tokens: 10000, output_tokens: 500 },
      };
    },
  };
  const meter = new MeteredProvider(provider, { maxRequests: 1 });
  await meter.decide({}, {});
  assert.equal(meter.usage.estimatedUsd, 0.00042);
  await assert.rejects(() => meter.decide({}, {}), /COST_BUDGET_EXCEEDED/);
  assert.equal(calls, 1);
  const unknown = new MeteredProvider({
    async decide() {
      return {
        model: "future",
        answers: {},
        usage: { input_tokens: 100, output_tokens: 1 },
      };
    },
  });
  await unknown.decide({}, {});
  assert.equal(unknown.usage.estimatedUsd, null);
  const failed = new MeteredProvider(noModel);
  await assert.rejects(() => failed.decide({}, {}));
  assert.equal(failed.usage.complete, false);
  assert.equal(failed.usage.failedRequests, 1);
});

test("generated fill values are bounded, cached, replayable as literals and separately metered", async () => {
  const app = await endpoint((_q, r) => {
    r.setHeader("content-type", "text/html");
    r.end("<label>Notes <textarea></textarea></label>");
  });
  const root = await mkdtemp(join(tmpdir(), "duit-writer-"));
  let calls = 0;
  const spec: CaseSpec = {
    name: "Write",
    baseUrl: app.url,
    variables: {},
    content: {
      enabled: true,
      maxRequests: 1,
      maxUsd: 0.01,
      inputPerMillion: 1,
      outputPerMillion: 2,
    },
    steps: [
      {
        instruction: "Write Notes",
        operation: "fill",
        control: { name: "Notes" },
        generate: { prompt: "Write a test note", maxChars: 40 },
      },
      {
        instruction: "Verify Notes",
        operation: "assert_value",
        control: { name: "Notes" },
        value: "Synthetic note",
      },
    ],
  };
  try {
    const report = await runCase(spec, {
      provider: noModel,
      contentProvider: {
        async generate() {
          calls++;
          return {
            text: "Synthetic note",
            model: "writer-test",
            inputTokens: 10,
            outputTokens: 3,
          };
        },
      },
      platform: new BrowserAdapter({ proxy: "direct" }),
      artifactsDir: root + "/run",
      screenshots: false,
    });
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(calls, 1);
    assert.equal(report.usage?.requests, 0);
    assert.equal(report.contentUsage?.estimatedUsd, 0.000016);
    const replay = JSON.parse(
      await readFile(root + "/run/replay.json", "utf8"),
    );
    assert.equal(replay.actions[0].value, "Synthetic note");
    assert.equal(replay.actions[0].generate, undefined);
    const authored = materializeFields(
      { ...spec, steps: [{ instruction: "Fill Notes", operation: "fill" }] },
      [{ step: 1, value: "Authored outside runtime" }],
    );
    assert.equal(
      (authored.steps[0] as { value: string }).value,
      "Authored outside runtime",
    );
    const writer = new FieldWriter(
      {
        async generate() {
          return {
            text: "note",
            model: "writer",
            inputTokens: 10,
            outputTokens: 1,
          };
        },
      },
      spec.content,
      (s) => s,
    );
    await writer.write({ prompt: "same" });
    await writer.write({ prompt: "same" });
    assert.equal(writer.usage.cacheHits, 1);
    await assert.rejects(() => writer.write({ prompt: "different" }), /BUDGET/);
    const expensive = new FieldWriter(
      {
        async generate() {
          return {
            text: "note",
            model: "writer",
            inputTokens: 100,
            outputTokens: 1,
          };
        },
      },
      { ...spec.content!, maxUsd: 0.000001 },
      (s) => s,
    );
    await assert.rejects(() => expensive.write({ prompt: "test" }), /BUDGET/);
    assert(expensive.usage.estimatedUsd > 0);
  } finally {
    await app.close();
  }
});

test("HTTP and MCP expose the same platform-independent lifecycle with auth and compact results", async () => {
  const root = await mkdtemp(join(tmpdir(), "duit-service-"));
  const registry = new PlatformRegistry().register("fake", () => ({
    async open() {},
    async close() {},
    async capture() {},
    async observe() {
      return {
        url: "http://example.test",
        title: "Test",
        text: "Ready",
        elements: [],
      };
    },
    async execute(a) {
      assert.equal(a.operation, "assert_text");
    },
  }));
  const service = new DuitService({
    platforms: registry,
    provider: () => noModel,
    artifactsRoot: root,
    maxActive: 1,
  });
  const api = await startHttp(service, {
    port: 0,
    token: "test-only-token-1234",
  });
  const spec = {
    name: "API",
    platform: "fake",
    baseUrl: "http://example.test",
    variables: {},
    steps: [
      { instruction: "Verify Ready", operation: "assert_text", value: "Ready" },
    ],
  };
  const request = (path: string, body?: unknown) =>
    fetch(api.url + path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${api.token}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const mcp = createMcpServer(service),
    client = new Client({ name: "test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    assert.equal((await fetch(api.url + "/v1/health")).status, 401);
    assert.equal(
      (
        await fetch(api.url + "/v1/health", {
          headers: {
            authorization: `Bearer ${api.token}`,
            origin: "https://evil.example",
          },
        })
      ).status,
      401,
    );
    const started = await request("/v1/runs", spec);
    assert.equal(started.status, 202);
    const { id } = (await started.json()) as { id: string };
    let status: any;
    for (let i = 0; i < 50; i++) {
      status = await (await request(`/v1/runs/${id}`)).json();
      if (status.state !== "running") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(status.report.status, "passed");
    assert.equal(status.report.usage.requests, 0);
    assert.equal(status.report.decisions, undefined);
    await mcp.connect(st);
    await client.connect(ct);
    assert(
      (await client.listTools()).tools.some((t) => t.name === "duit_retry"),
    );
    const opened = await client.callTool({
      name: "duit_session_open",
      arguments: { case: spec },
    });
    const sid = JSON.parse(
      (opened.content as Array<{ text: string }>)[0].text,
    ).id;
    const result = await client.callTool({
      name: "duit_step",
      arguments: { id: sid, step: spec.steps[0] },
    });
    assert.equal(
      JSON.parse((result.content as Array<{ text: string }>)[0].text).status,
      "passed",
    );
    const closed = await client.callTool({
      name: "duit_session_close",
      arguments: { id: sid },
    });
    assert.equal(
      JSON.parse((closed.content as Array<{ text: string }>)[0].text).status,
      "passed",
    );
  } finally {
    await client.close();
    await mcp.close();
    await api.close();
  }
});

test("text assertions follow a popup that opens after the click event grace period", async () => {
  const app = await endpoint((q, r) => {
    r.setHeader("content-type", "text/html");
    r.end(
      q.url === "/new"
        ? "<h1>New Window</h1>"
        : `<button onclick="setTimeout(()=>window.open('/new'),700)">Open</button>`,
    );
  });
  const browser = new BrowserAdapter({ proxy: "direct", timeoutMs: 3000 });
  try {
    await browser.open(app.url);
    await browser.execute({
      text: "Open",
      operation: "click",
      target: { frame: 0, kind: "role", value: "button", name: "Open" },
    });
    await browser.execute({
      text: "Verify New Window",
      operation: "assert_text",
      value: "New Window",
    });
    assert.equal((await browser.observe()).url, app.url + "/new");
  } finally {
    await browser.close();
    await app.close();
  }
});

test("OpenAI-compatible writer transport is isolated and generated variable syntax stays literal in replay", async () => {
  const { OpenAIContentProvider } =
    await import("../src/providers/openai-content.js");
  const { parseReplay } = await import("../src/core/replay.js");
  let calls = 0;
  const api = await endpoint((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls++;
      const body = JSON.parse(raw);
      assert.equal(req.headers.authorization, "Bearer writer-test-key");
      assert.equal(body.messages.length, 2);
      assert.equal(body.tools, undefined);
      assert.equal(body.max_tokens, 60);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          model: "writer-fixture",
          choices: [
            { message: { content: "A literal ${NOT_A_VARIABLE} note" } },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 8 },
        }),
      );
    });
  });
  const app = await endpoint((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<label>Note <textarea></textarea></label>");
  });
  const root = await mkdtemp(join(tmpdir(), "duit-writer-http-"));
  const writer = new OpenAIContentProvider({
    endpoint: api.url,
    model: "writer-fixture",
    apiKey: "writer-test-key",
  });
  const spec: CaseSpec = {
    name: "Literal generated content",
    baseUrl: app.url,
    variables: {},
    content: {
      enabled: true,
      maxRequests: 1,
      maxUsd: 0.01,
      inputPerMillion: 1,
      outputPerMillion: 2,
      maxOutputTokens: 60,
    },
    steps: [
      {
        instruction: "Write Note",
        operation: "fill",
        control: { name: "Note" },
        generate: { prompt: "A synthetic note" },
      },
      {
        instruction: "Verify Note is populated",
        operation: "assert_nonempty",
        control: { name: "Note" },
      },
    ],
  };
  try {
    const live = await runCase(spec, {
      provider: noModel,
      contentProvider: writer,
      platform: new BrowserAdapter({ proxy: "direct" }),
      artifactsDir: root + "/live",
      screenshots: false,
    });
    assert.equal(live.status, "passed", JSON.stringify(live));
    const plan = parseReplay(
      JSON.parse(await readFile(root + "/live/replay.json", "utf8")),
    );
    assert.equal(plan.actions[0].literalValue, true);
    const replay = await runCase(
      { ...spec, content: undefined },
      {
        replay: plan,
        platform: new BrowserAdapter({ proxy: "direct" }),
        artifactsDir: root + "/replay",
        screenshots: false,
      },
    );
    assert.equal(replay.status, "passed", JSON.stringify(replay));
    assert.equal(calls, 1);
    assert.equal(replay.usage?.requests, 0);
  } finally {
    await writer.close();
    await app.close();
    await api.close();
  }
});
