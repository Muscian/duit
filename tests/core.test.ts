import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCase,
  literalCandidates,
  resolveVariables,
  substitute,
} from "../src/core/input.js";
import { validateResponse } from "../src/providers/jev.js";
import { gate, defaultPolicy, DecisionEngine } from "../src/core/decisions.js";
import { runCase } from "../src/core/runner.js";
import { parseReplay } from "../src/core/replay.js";
import {
  type DecisionProvider,
  type ChoiceQuestion,
  type PlatformAdapter,
  type ResolvedAction,
  HarnessError,
} from "../src/core/types.js";

const question: Record<string, ChoiceQuestion> = {
  q: { type: "choice", instructions: "pick", criteria: { a: "A", b: "B" } },
};
const response = {
  model: "test",
  usage: { input_tokens: 2, output_tokens: 1 },
  answers: {
    q: {
      type: "choice",
      choice: "a",
      confidence: 0.9,
      probabilities: { a: 0.95, b: 0.05 },
    },
  },
};
test("strict input, numbered lists, YAML validation, and non-HTTP rejection", () => {
  assert.deepEqual(
    parseCase('1. Click Save\n2. Verify "Saved" is visible', {
      plainText: true,
      baseUrl: "http://localhost",
    }).steps,
    ["Click Save", 'Verify "Saved" is visible'],
  );
  assert.throws(() =>
    parseCase("name: Test\nbaseUrl: file:///etc/passwd\nsteps: [Click]"),
  );
  assert.throws(() =>
    parseCase("name: Test\nbaseUrl: http://localhost\nsteps: []"),
  );
});
test("values are verbatim spans; missing variables never become undefined", () => {
  assert.deepEqual(literalCandidates('Escribí "Ana García" en "Nombre"'), [
    "Ana García",
    "Nombre",
  ]);
  assert(
    literalCandidates("Enter ana@example.com in email").includes(
      "ana@example.com",
    ),
  );
  assert.deepEqual(literalCandidates('Write "" in Name'), [""]);
  assert.equal(substitute("${A}", { A: "<secret>" }), "<secret>");
  assert.throws(
    () => resolveVariables({ A: "env:NOT_SET" }, {}),
    /MISSING_VARIABLE/,
  );
  assert.throws(() => substitute("${B}", {}), /MISSING_VARIABLE/);
});
test("model protocol rejects invented choices, missing answers and malformed distributions", () => {
  assert.equal(validateResponse(response, question).answers.q.choice, "a");
  for (const mutated of [
    { ...response, answers: {} },
    {
      ...response,
      answers: { q: { ...response.answers.q, choice: "click_everything" } },
    },
    {
      ...response,
      answers: {
        q: { ...response.answers.q, probabilities: { a: NaN, b: 0 } },
      },
    },
    {
      ...response,
      answers: {
        q: { ...response.answers.q, probabilities: { a: 0.6, b: 0.6 } },
      },
    },
    {
      ...response,
      answers: {
        q: { ...response.answers.q, probabilities: { a: 0.1, b: 0.9 } },
      },
    },
  ])
    assert.throws(
      () => validateResponse(mutated, question),
      /INVALID_MODEL_RESPONSE/,
    );
});
test("confidence gates stop ambiguous decisions", () => {
  assert.equal(
    gate(
      validateResponse(response, question).answers.q,
      defaultPolicy,
      "target",
    ),
    "a",
  );
  assert.throws(
    () =>
      gate(
        {
          type: "choice",
          choice: "a",
          confidence: 0.9,
          probabilities: { a: 0.51, b: 0.49 },
        },
        defaultPolicy,
        "target",
      ),
    /UNCERTAIN_DECISION/,
  );
});
class Provider implements DecisionProvider {
  requests: unknown[] = [];
  constructor(private select: (id: string, q: ChoiceQuestion) => string) {}
  async decide(state: unknown, qs: Record<string, ChoiceQuestion>) {
    this.requests.push({ state, qs });
    return {
      model: "scripted-test-provider",
      usage: { input_tokens: 0, output_tokens: 0 },
      answers: Object.fromEntries(
        Object.entries(qs).map(([id, q]) => {
          const selected = this.select(id, q);
          return [
            id,
            {
              type: "choice" as const,
              choice: selected,
              confidence: 1,
              probabilities: Object.fromEntries(
                Object.keys(q.criteria).map((k) => [k, k === selected ? 1 : 0]),
              ),
            },
          ];
        }),
      ),
    };
  }
}
class Platform implements PlatformAdapter {
  opened = false;
  closed = false;
  actions: ResolvedAction[] = [];
  async open() {
    this.opened = true;
  }
  async observe() {
    return { url: "http://localhost", title: "test", elements: [] };
  }
  async execute(a: ResolvedAction) {
    this.actions.push(a);
    throw new Error("Expected text not visible; password=private-value");
  }
  async capture() {}
  async close() {
    this.closed = true;
  }
}
test("unsupported steps stop before any browser interaction", async () => {
  const provider = new Provider(() => "unsupported");
  const engine = new DecisionEngine(provider);
  await assert.rejects(
    engine.compile(["Login and buy something"]),
    /UNSUPPORTED_STEP/,
  );
});
test("failed assertions produce failure evidence, redact secrets and never save successful replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "duit-"));
  const platform = new Platform();
  const provider = new Provider((id) =>
    id === "value" ? "v0" : "assert_text",
  );
  const report = await runCase(
    {
      name: "Failure",
      baseUrl: "http://localhost",
      variables: { PASSWORD: "private-value" },
      steps: ['Verify "never-present" is visible'],
    },
    { provider, platform, artifactsDir: join(root, "run"), screenshots: false },
  );
  assert.equal(report.status, "failed");
  assert(platform.closed);
  assert.equal(platform.actions.length, 1);
  const json = await readFile(join(root, "run/report.json"), "utf8");
  assert(!json.includes("private-value"));
  assert(json.includes("[REDACTED]"));
  assert.match(
    await readFile(join(root, "run/junit.xml"), "utf8"),
    /failures="1"/,
  );
  await assert.rejects(access(join(root, "run/replay.json")));
  await assert.rejects(
    runCase(
      {
        name: "Failure",
        baseUrl: "http://localhost",
        variables: {},
        steps: ["Verify something"],
      },
      { provider, platform, artifactsDir: join(root, "run") },
    ),
    /EEXIST/,
  );
});
test("action-only cases and missing variables block before opening browser", async () => {
  for (const [op, steps, vars] of [
    ["click", ["Click Save"], {}],
    ["assert_text", ['Verify "${MISSING}" is visible'], {}],
  ] as const) {
    const platform = new Platform(),
      root = await mkdtemp(join(tmpdir(), "duit-"));
    const report = await runCase(
      {
        name: "Blocked",
        baseUrl: "http://localhost",
        variables: vars,
        steps: [...steps],
      },
      {
        provider: new Provider((id) => (id === "value" ? "v0" : op)),
        platform,
        artifactsDir: join(root, "run"),
        screenshots: false,
      },
    );
    assert.equal(report.status, "blocked");
    assert(!platform.opened);
    assert(platform.closed);
  }
});
test("replay schema rejects arbitrary operations and missing targets", () => {
  const plan = {
    version: 1,
    name: "Replay",
    baseUrl: "http://localhost",
    variables: {},
    actions: [{ text: "evil", operation: "eval", value: "process.exit()" }],
  };
  assert.throws(() => parseReplay(plan));
  assert.throws(() =>
    parseReplay({ ...plan, actions: [{ text: "click", operation: "click" }] }),
  );
});
test("cancellation closes the platform and cannot report success", async () => {
  const root = await mkdtemp(join(tmpdir(), "duit-")),
    controller = new AbortController();
  controller.abort();
  const platform = new Platform();
  const report = await runCase(
    {
      name: "Cancel",
      baseUrl: "http://localhost",
      variables: {},
      steps: ["Check"],
    },
    {
      platform,
      artifactsDir: join(root, "run"),
      signal: controller.signal,
      replay: {
        version: 1,
        name: "Cancel",
        baseUrl: "http://localhost",
        variables: {},
        actions: [{ text: "Check", operation: "assert_text", value: "ok" }],
      },
    },
  );
  assert.equal(report.status, "blocked");
  assert(platform.closed);
  assert(!platform.opened);
});
test("page-controlled content is sanitized before going to the decision provider", async () => {
  const provider = new Provider(() => "none"),
    engine = new DecisionEngine(provider, defaultPolicy, (s) =>
      s.replaceAll("private-value", "[REDACTED]"),
    );
  await assert.rejects(
    engine.resolve(
      { text: "Click Save", operation: "click" },
      {
        url: "http://localhost",
        title: "private-value",
        elements: [
          {
            id: "e0",
            tag: "button",
            role: "button",
            name: "Save",
            text: "Save",
            type: "",
            disabled: false,
            visible: true,
            context: "private-value",
            locator: { frame: 0, kind: "css", value: "button" },
          },
        ],
      },
    ),
    HarnessError,
  );
  assert(!JSON.stringify(provider.requests).includes("private-value"));
});
test("a deadline during screenshot capture cannot turn a cancelled run into passed", async () => {
  const root = await mkdtemp(join(tmpdir(), "duit-")),
    controller = new AbortController();
  const platform: PlatformAdapter = {
    async open() {},
    async observe() {
      return { url: "http://localhost", title: "Test", elements: [] };
    },
    async execute() {},
    async capture() {
      controller.abort();
    },
    async close() {},
  };
  const report = await runCase(
    {
      name: "Cancel screenshot",
      baseUrl: "http://localhost",
      variables: {},
      steps: ["Check"],
    },
    {
      platform,
      artifactsDir: join(root, "run"),
      signal: controller.signal,
      replay: {
        version: 1,
        name: "Cancel screenshot",
        baseUrl: "http://localhost",
        variables: {},
        actions: [{ text: "Check", operation: "assert_text", value: "ok" }],
      },
    },
  );
  assert.equal(report.status, "blocked");
  assert.equal(report.steps[0].status, "blocked");
});
