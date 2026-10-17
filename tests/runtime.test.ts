import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserAdapter } from "../src/platforms/browser.js";
import { HarnessSession } from "../src/core/session.js";
import { runCase } from "../src/core/runner.js";
import { parseReplay } from "../src/core/replay.js";
import { DecisionEngine } from "../src/core/decisions.js";
import {
  HarnessError,
  type DecisionProvider,
  type ChoiceQuestion,
  type Observation,
  type PlatformAdapter,
  type ResolvedAction,
} from "../src/core/types.js";

class Provider implements DecisionProvider {
  async decide(raw: unknown, questions: Record<string, ChoiceQuestion>) {
    const state = raw as {
      steps?: string[];
      step?: string;
      allowedAliases?: string[];
    };
    const answers = Object.fromEntries(
      Object.entries(questions).map(([id, q]) => {
        let selected = "none";
        if (id.startsWith("step")) {
          const text = state.steps![Number(id.slice(4))];
          selected = text.startsWith("Enter")
            ? "fill"
            : text.startsWith("Check")
              ? "check"
              : text.startsWith("Verify")
                ? "assert_text"
                : "click";
        } else if (id === "value")
          selected = Object.keys(q.criteria).find((k) => k !== "none")!;
        else {
          const labels = state.allowedAliases ?? [];
          const named = (state.step ?? "")
            .replace(/^(Click|Enter|Check)\s+/, "")
            .replaceAll('"', "");
          const matches = Object.entries(q.criteria).filter(([key, value]) => {
            if (key === "none") return false;
            const c = value as { name: string };
            return (
              labels.includes(c.name) ||
              c.name === named ||
              ((state.step ?? "").includes(c.name) && !!c.name)
            );
          });
          if (matches.length === 1) selected = matches[0][0];
        }
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
    );
    return {
      model: "test",
      answers,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}
async function endpoint(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("a fresh session dismisses notices, follows its popup, resolves an alias, scopes duplicate fields, applies once and cleans up", async () => {
  let applied = 0,
    removed = 0;
  const app = await endpoint((req, res) => {
    if (req.url === "/applied") {
      applied++;
      res.end("ok");
      return;
    }
    if (req.url === "/removed") {
      removed++;
      res.end("ok");
      return;
    }
    res.setHeader("content-type", "text/html");
    if (req.url === "/omni") {
      res.end(
        `<h1>Omni</h1><div role="dialog" aria-label="Welcome"><h2>Welcome</h2><a style="cursor:pointer" onclick="this.parentElement.remove()">Start exploring</a></div><button onclick="document.querySelector('form').hidden=false">Apply Policy</button><form hidden><div><div>Request Headers</div><section><label>Name<input></label><label>Value<input></label></section></div><div><div>Response Headers</div><section><label>Name<input></label><label>Value<input></label></section></div><label>stage-a<input type="checkbox"></label><label>stage-b<input type="checkbox"></label><button type="button" onclick="if(document.querySelectorAll('input:checked').length!==1)throw Error('scope');fetch('/applied');document.querySelector('output').textContent='Policy applied'">Apply</button></form><output></output><button onclick="fetch('/removed');document.querySelector('output').textContent='No policies'">Delete Policy</button>`,
      );
    } else
      res.end(
        `<h1>Login</h1><div role="dialog" style="position:fixed;inset:0;background:white;z-index:10" aria-label="Cookies"><p>Cookie consent</p><button onclick="this.parentElement.remove()">Accept cookies</button></div><button onclick="window.open('/omni')">Open Omni</button>`,
      );
  });
  const root = await mkdtemp(join(tmpdir(), "duit-runtime-"));
  try {
    const report = await runCase(
      {
        name: "New UI",
        browser: { allowedOrigins: [app.url] },
        publicVariables: [],
        baseUrl: app.url,
        variables: {},
        interruptions: [
          {
            name: "Cookies",
            when: { text: "Cookie consent" },
            action: "Click Accept cookies",
          },
          {
            name: "Welcome",
            when: { text: "Welcome" },
            action: "Click Start exploring",
          },
        ],
        steps: [
          "Click Open Omni",
          {
            instruction: "Click Add Policy",
            aliases: ["Apply Policy"],
            context: { urlIncludes: "/omni", text: "Omni" },
          },
          { instruction: 'Enter "X-Source" in Name', scope: "Request Headers" },
          { instruction: 'Enter "test" in Value', scope: "Request Headers" },
          {
            instruction: 'Enter "X-Served" in Name',
            scope: "Response Headers",
          },
          { instruction: 'Enter "test" in Value', scope: "Response Headers" },
          "Check stage-a",
          "Click Apply",
          'Verify "Policy applied"',
        ],
        cleanup: ["Click Delete Policy", 'Verify "No policies"'],
      },
      {
        provider: new Provider(),
        platform: new BrowserAdapter({ proxy: "direct", timeoutMs: 1500 }),
        artifactsDir: join(root, "run"),
        screenshots: false,
        readinessTimeoutMs: 1000,
      },
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(applied, 1);
    assert.equal(removed, 1);
    assert.equal(
      report.interruptions?.filter((e) => e.status === "passed").length,
      2,
    );
    assert(report.cleanup?.every((s) => s.status === "passed"));
    assert.match(report.diagnostics?.url ?? "", /\/omni$/);
    const replay = JSON.parse(
      await readFile(join(root, "run/replay.json"), "utf8"),
    );
    assert.deepEqual(parseReplay(replay).browser, {
      allowedOrigins: [app.url],
    });
    assert.equal(replay.actions[0].text, "Click Accept cookies");
    assert(
      replay.actions.some(
        (a: { text: string }) => a.text === "Click Start exploring",
      ),
    );
    assert.equal(replay.actions.at(-1).text, 'Verify "No policies"');
  } finally {
    await app.close();
  }
});

test("a new-window navigation outside allowed origins blocks without poisoning inspection", async () => {
  const other = await endpoint((_q, r) => r.end("<h1>Other</h1>"));
  const app = await endpoint((_q, r) => {
    r.setHeader("content-type", "text/html");
    r.end(
      `<button onclick="window.open('${other.url}')">Open</button><h1>Original</h1>`,
    );
  });
  const browser = new BrowserAdapter({
    proxy: "direct",
    navigationTimeoutMs: 300,
    timeoutMs: 500,
  });
  try {
    await browser.open(app.url);
    await assert.rejects(
      browser.execute({
        text: "Open",
        operation: "click",
        target: { frame: 0, kind: "role", value: "button", name: "Open" },
      }),
      /NAVIGATION_BLOCKED/,
    );
    assert.equal((await browser.observe()).url, app.url + "/");
  } finally {
    await browser.close();
    await app.close();
    await other.close();
  }
});

class StatefulPlatform implements PlatformAdapter {
  opens = 0;
  closed = false;
  mutations = 0;
  allowTarget = false;
  applied = false;
  async open() {
    this.opens++;
  }
  async observe(): Promise<Observation> {
    return {
      url: "http://localhost/omni",
      title: "Omni",
      text: this.applied ? "Applied" : "Ready",
      elements: this.allowTarget
        ? [
            {
              id: "e0",
              tag: "button",
              role: "button",
              name: "Apply",
              text: "Apply",
              type: "",
              disabled: false,
              visible: true,
              context: "Omni",
              locator: {
                frame: 0,
                kind: "role",
                value: "button",
                name: "Apply",
              },
            },
          ]
        : [],
    };
  }
  async execute(a: ResolvedAction) {
    if (a.operation === "click") {
      this.mutations++;
      this.applied = true;
      throw new Error("connection lost after click");
    }
    if (a.operation === "assert_text") assert.equal(a.value, "Applied");
  }
  async capture() {}
  async close() {
    this.closed = true;
  }
}
test("live retry retains the page, tracks retry chains, checkpoints before dispatch and forbids repeating an uncertain Apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "duit-session-"));
  const platform = new StatefulPlatform();
  const originalExecute = platform.execute.bind(platform);
  platform.execute = async (a) => {
    if (a.operation === "click") {
      const checkpoint = JSON.parse(
        await readFile(join(root, "run/checkpoint.json"), "utf8"),
      );
      assert.equal(checkpoint.steps.at(-1).phase, "dispatch");
    }
    return originalExecute(a);
  };
  const session = new HarnessSession(
    {
      name: "Resume",
      baseUrl: "http://localhost",
      variables: {},
      steps: ["Click Apply"],
    },
    {
      provider: new Provider(),
      platform,
      artifactsDir: join(root, "run"),
      readinessTimeoutMs: 10,
      screenshots: false,
    },
  );
  await session.open();
  try {
    assert.equal((await session.step("Click Apply")).status, "blocked");
    assert.equal((await session.retry()).status, "blocked");
    platform.allowTarget = true;
    const uncertain = await session.retry();
    assert.equal(uncertain.phase, "dispatch");
    assert.match(uncertain.error!, /ACTION_OUTCOME_UNKNOWN/);
    assert.equal(platform.mutations, 1);
    assert.equal(platform.opens, 1);
    assert(!platform.closed);
    await assert.rejects(session.retry(), /ACTION_OUTCOME_UNKNOWN/);
    assert.equal((await session.confirm('Verify "Pending"')).status, "failed");
    const unsafeRetry = await session.retry("Click Apply");
    assert.match(unsafeRetry.error!, /CONFIRM_REQUIRES_ASSERTION/);
    assert.equal((await session.confirm('Verify "Applied"')).status, "passed");
    assert.equal(platform.mutations, 1);
  } finally {
    await session.close();
  }
  assert.equal(session.report.status, "passed");
  assert(
    session.report.steps.slice(0, 3).every((s) => s.recoveredBy !== undefined),
  );
  await assert.rejects(access(join(root, "run/replay.json")));
});

test("context mismatches dispatch nothing and cleanup runs after a failing assertion", async () => {
  const root = await mkdtemp(join(tmpdir(), "duit-context-"));
  const platform = new StatefulPlatform();
  platform.allowTarget = true;
  const session = new HarnessSession(
    {
      name: "Context",
      baseUrl: "http://localhost",
      variables: {},
      steps: ["Click Apply"],
    },
    {
      provider: new Provider(),
      platform,
      artifactsDir: join(root, "context"),
      readinessTimeoutMs: 10,
      screenshots: false,
    },
  );
  await session.open();
  try {
    const result = await session.step({
      instruction: "Click Apply",
      context: { urlIncludes: "/wrong-app" },
    });
    assert.equal(result.phase, "context");
    assert.match(result.error!, /CONTEXT_MISMATCH/);
    assert.equal(platform.mutations, 0);
  } finally {
    await session.close();
  }
  const calls: string[] = [];
  const cleanupPlatform: PlatformAdapter = {
    async open() {},
    async close() {},
    async capture() {},
    async observe() {
      return { url: "http://localhost", title: "test", elements: [] };
    },
    async execute(a) {
      calls.push(a.value!);
      if (a.value === "Impossible") throw new Error("assertion failed");
    },
  };
  const report = await runCase(
    {
      name: "Cleanup",
      baseUrl: "http://localhost",
      variables: {},
      steps: ['Verify "Impossible"'],
      cleanup: ['Verify "Cleaned"'],
    },
    {
      provider: new Provider(),
      platform: cleanupPlatform,
      artifactsDir: join(root, "cleanup"),
      screenshots: false,
    },
  );
  assert.equal(report.status, "failed");
  assert.deepEqual(calls, ["Impossible", "Cleaned"]);
  assert.equal(report.cleanup?.[0].status, "passed");
});

test("pointer styling does not multiply catalogue cards and aliases remain explicit", async () => {
  const app = await endpoint((_q, r) => {
    r.setHeader("content-type", "text/html");
    r.end(
      "<style>button,button * {cursor:pointer}</style>" +
        Array.from(
          { length: 120 },
          (_, i) =>
            `<button aria-label="Select policy ${i}"><h3>Policy ${i}</h3><p>Description ${i}</p><span data-testid="badge-${i}">Open</span></button>`,
        ).join(""),
    );
  });
  const browser = new BrowserAdapter({ proxy: "direct" });
  try {
    await browser.open(app.url);
    const observed = await browser.observe();
    assert.equal(
      observed.elements.filter((e) => e.role === "button").length,
      120,
    );
    const engine = new DecisionEngine(new Provider());
    const step = (
      await engine.compile([
        { instruction: "Click policy renamed", aliases: ["Select policy 119"] },
      ])
    )[0];
    assert((await engine.resolve(step, observed)).target);
  } finally {
    await browser.close();
    await app.close();
  }
});

test("hidden contextual notice text cannot activate an interruption rule", async () => {
  const root = await mkdtemp(join(tmpdir(), "duit-hidden-notice-"));
  const platform = new StatefulPlatform();
  platform.allowTarget = true;
  const observe = platform.observe.bind(platform);
  platform.observe = async () => {
    const o = await observe();
    o.elements[0].context = "Hidden Welcome to Agent Fabric";
    return o;
  };
  const session = new HarnessSession(
    {
      name: "Hidden notice",
      baseUrl: "http://localhost",
      variables: {},
      steps: ['Verify "Applied"'],
      interruptions: [
        {
          name: "Welcome",
          when: { text: "Welcome to Agent Fabric" },
          action: "Click Start exploring",
        },
      ],
    },
    {
      provider: new Provider(),
      platform,
      artifactsDir: join(root, "run"),
      screenshots: false,
    },
  );
  await session.open();
  try {
    assert.equal((await session.step('Verify "Applied"')).status, "passed");
    assert.equal(session.report.interruptions?.length, 0);
    assert.equal(platform.mutations, 0);
  } finally {
    await session.close();
  }
});

test("nested field sections and repeated activity statuses retain their local identity", async () => {
  const app = await endpoint((_q, r) => {
    r.setHeader("content-type", "text/html");
    r.end(
      `<div><div>Request Headers</div><div><label>Name<input></label><div><div>Source</div><label>Type<input></label><label>Value<input value="request"></label></div></div></div><div><div>Response Headers</div><div><label>Name<input></label><div><div>Source</div><label>Type<input></label><label>Value<input value="response"></label></div></div></div><table><tbody><tr><td>Header Mapping</td><td>Removed</td><td>Completed</td></tr><tr><td>Header Mapping</td><td>Applied</td><td>Completed</td></tr></tbody></table>`,
    );
  });
  const browser = new BrowserAdapter({ proxy: "direct" });
  try {
    await browser.open(app.url);
    const observed = await browser.observe();
    const values = observed.elements.filter(
      (e) => e.name === "Value" && e.role === "textbox",
    );
    assert.equal(values.length, 2);
    assert.match(values[0].context, /Request Headers/);
    assert.doesNotMatch(values[0].context, /Response Headers/);
    assert.match(values[1].context, /Response Headers/);
    const completed = observed.elements.filter((e) => e.name === "Completed");
    assert.equal(completed.length, 2);
    assert.match(
      completed[0].context,
      /Row 1: Header Mapping Removed Completed/,
    );
    assert.match(
      completed[1].context,
      /Row 2: Header Mapping Applied Completed/,
    );
    const action = await new DecisionEngine(new Provider()).resolve(
      {
        text: "Click Value",
        operation: "assert_value",
        value: "request",
        scope: "Request Headers",
      },
      observed,
    );
    await browser.execute(action);
  } finally {
    await browser.close();
    await app.close();
  }
});

test("a notice replaced before dispatch is re-observed without clicking its stale control", async () => {
  const root = await mkdtemp(join(tmpdir(), "duit-notice-race-"));
  let phase = 0;
  const clicks: string[] = [];
  const platform: PlatformAdapter = {
    async open() {},
    async close() {},
    async capture() {},
    async observe() {
      const name = phase === 0 ? "Close old" : "Close new";
      return {
        url: "http://localhost",
        title: "Test",
        text: phase === 0 ? "Old notice" : phase === 1 ? "New notice" : "Ready",
        elements:
          phase === 2
            ? []
            : [
                {
                  id: "e0",
                  tag: "button",
                  role: "button",
                  name,
                  text: name,
                  type: "",
                  visible: true,
                  disabled: false,
                  context: "",
                  locator: {
                    frame: 0,
                    kind: "role" as const,
                    value: "button",
                    name,
                  },
                },
              ],
      };
    },
    async prepare(action) {
      if (action.operation === "click" && phase === 0) {
        phase = 1;
        throw new HarnessError(
          "UI_NOT_ACTIONABLE",
          "Page changed before click",
        );
      }
    },
    async execute(action) {
      if (action.operation === "click") {
        clicks.push(action.target!.name!);
        phase = 2;
      } else assert.equal(phase, 2);
    },
  };
  const session = new HarnessSession(
    {
      name: "Notice race",
      baseUrl: "http://localhost",
      variables: {},
      steps: ['Verify "Ready"'],
      interruptions: [
        {
          name: "Old",
          when: { text: "Old notice" },
          action: "Click Close old",
        },
        {
          name: "New",
          when: { text: "New notice" },
          action: "Click Close new",
        },
      ],
    },
    {
      provider: new Provider(),
      platform,
      artifactsDir: join(root, "run"),
      screenshots: false,
    },
  );
  await session.open();
  try {
    assert.equal((await session.step('Verify "Ready"')).status, "passed");
    assert.deepEqual(clicks, ["Close new"]);
  } finally {
    await session.close();
  }
});

test("a late overlay between trial and actual click is handled before any mutation", async () => {
  let mutations = 0;
  const app = await endpoint((q, r) => {
    if (q.url === "/apply") {
      mutations++;
      r.end("ok");
      return;
    }
    r.setHeader("content-type", "text/html");
    r.end(
      `<button onclick="document.getElementById('notice').hidden=false">Show notice</button><button onclick="fetch('/apply');document.querySelector('output').textContent='Applied'">Apply</button><output></output><div id="notice" role="dialog" aria-label="Cookies" hidden style="position:fixed;inset:0;z-index:10;background:white"><p>Cookie consent</p><button onclick="this.parentElement.hidden=true">Accept cookies</button></div>`,
    );
  });
  const root = await mkdtemp(join(tmpdir(), "duit-late-overlay-"));
  const browser = new BrowserAdapter({ proxy: "direct", timeoutMs: 3000 });
  const prepare = browser.prepare.bind(browser);
  let injected = false;
  browser.prepare = async (action) => {
    await prepare(action);
    if (action.target?.name === "Apply" && !injected) {
      injected = true;
      await browser.execute({
        text: "Show notice",
        operation: "click",
        target: {
          frame: 0,
          kind: "role",
          value: "button",
          name: "Show notice",
        },
      });
    }
  };
  try {
    const report = await runCase(
      {
        name: "Late overlay",
        baseUrl: app.url,
        variables: {},
        steps: ["Click Apply", 'Verify "Applied"'],
        interruptions: [
          {
            name: "Cookie",
            when: { text: "Cookie consent" },
            action: "Click Accept cookies",
          },
        ],
      },
      {
        provider: new Provider(),
        platform: browser,
        artifactsDir: join(root, "run"),
        screenshots: false,
      },
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(mutations, 1);
    assert.equal(report.interruptions?.[0].status, "passed");
  } finally {
    await browser.close();
    await app.close();
  }
});

test("bounded assertion polling refreshes read-only state and rejects polling a mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "duit-poll-"));
  let refreshes = 0,
    opens = 0;
  const platform: PlatformAdapter = {
    async open() {
      opens++;
    },
    async close() {},
    async capture() {},
    async refresh() {
      refreshes++;
    },
    async observe() {
      return {
        url: "http://localhost",
        title: "Test",
        text: refreshes ? "Completed" : "Running",
        elements: [],
      };
    },
    async execute(action) {
      assert.equal(action.operation, "assert_text");
      assert.equal(refreshes, 1);
    },
  };
  const report = await runCase(
    {
      name: "Wait for activity",
      baseUrl: "http://localhost",
      variables: {},
      steps: [
        {
          instruction: 'Verify "Completed"',
          wait: { timeoutMs: 2000, intervalMs: 250, refreshPage: true },
        },
      ],
    },
    {
      provider: new Provider(),
      platform,
      artifactsDir: join(root, "success"),
      screenshots: false,
    },
  );
  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.equal(report.steps[0].pollAttempts, 2);
  assert.equal(refreshes, 1);
  const replay = parseReplay(
    JSON.parse(await readFile(join(root, "success/replay.json"), "utf8")),
  );
  assert.equal(replay.actions[0].wait?.refreshPage, true);
  const invalid = await runCase(
    {
      name: "Never poll apply",
      baseUrl: "http://localhost",
      variables: {},
      steps: [{ instruction: "Click Apply", wait: { timeoutMs: 2000 } }],
    },
    {
      provider: new Provider(),
      platform,
      artifactsDir: join(root, "invalid"),
      screenshots: false,
    },
  );
  assert.match(invalid.error!, /INVALID_WAIT/);
  assert.equal(opens, 1);
});

test("unique explicit labels bind deterministically while duplicate labels still require a decision", async () => {
  let decisions = 0;
  const delegate = new Provider();
  const engine = new DecisionEngine({
    async decide(state, questions) {
      decisions++;
      return delegate.decide(state, questions);
    },
  });
  const element = {
    id: "e0",
    tag: "button",
    role: "button",
    name: "Cancel",
    text: "Cancel",
    type: "",
    disabled: false,
    visible: true,
    context: "Footer",
    locator: {
      frame: 0,
      kind: "role" as const,
      value: "button",
      name: "Cancel",
    },
  };
  const observation = {
    url: "http://localhost",
    title: "Test",
    elements: [element],
  };
  const action = await engine.resolve(
    { text: "Click the Cancel button", operation: "click" },
    observation,
  );
  assert.equal(action.resolution, "exact-label");
  assert.equal(decisions, 0);
  await assert.rejects(
    engine.resolve(
      { text: "Click Cancel", operation: "click" },
      {
        ...observation,
        elements: [element, { ...element, id: "e1", context: "Header" }],
      },
    ),
    /NO_TARGET/,
  );
  assert.equal(decisions, 1);
});

test("refresh reloads the document even when the activity view uses a URL fragment", async () => {
  let documents = 0;
  const app = await endpoint((q, r) => {
    if (q.url !== "/activities") {
      r.end();
      return;
    }
    documents++;
    r.setHeader("content-type", "text/html");
    r.end(`<p>${documents > 1 ? "Completed" : "Running"}</p>`);
  });
  const browser = new BrowserAdapter({ proxy: "direct" });
  try {
    await browser.open(app.url + "/activities#log");
    assert.match((await browser.observe()).text!, /Running/);
    await browser.refresh();
    assert.match((await browser.observe()).text!, /Completed/);
    assert.equal(documents, 2);
  } finally {
    await browser.close();
    await app.close();
  }
});

test("assertion polling refreshes a cached SPA through its named button without reloading", async () => {
  let documents = 0;
  const app = await endpoint((q, r) => {
    if (q.url !== "/activity") {
      r.end();
      return;
    }
    documents++;
    r.setHeader("content-type", "text/html");
    r.end(
      `<button onclick="document.querySelector('p').textContent='Completed'">Refresh activity</button><p>Running</p>`,
    );
  });
  const root = await mkdtemp(join(tmpdir(), "duit-refresh-control-"));
  const browser = new BrowserAdapter({ proxy: "direct", timeoutMs: 500 });
  try {
    const report = await runCase(
      {
        name: "Refresh activity in place",
        baseUrl: app.url + "/activity",
        variables: {},
        steps: [
          {
            instruction: 'Verify "Completed"',
            wait: {
              timeoutMs: 5000,
              intervalMs: 250,
              refreshControl: "Refresh activity",
            },
          },
        ],
      },
      {
        provider: new Provider(),
        platform: browser,
        artifactsDir: join(root, "run"),
        screenshots: false,
      },
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(report.steps[0].pollAttempts, 2);
    assert.equal(documents, 1);
    const replay = parseReplay(
      JSON.parse(await readFile(join(root, "run/replay.json"), "utf8")),
    );
    assert.equal(replay.actions[0].wait?.refreshControl, "Refresh activity");
    assert.throws(
      () =>
        parseReplay({
          ...replay,
          actions: [
            {
              ...replay.actions[0],
              wait: {
                timeoutMs: 5000,
                refreshPage: true,
                refreshControl: "Refresh activity",
              },
            },
          ],
        }),
      /Choose refreshPage/,
    );
  } finally {
    await browser.close();
    await app.close();
  }
});

test("refresh controls must be unique visible buttons", async () => {
  const app = await endpoint((_q, r) => {
    r.setHeader("content-type", "text/html");
    r.end(
      '<button>Refresh activity</button><button>Refresh activity</button><a href="#">Reload list</a>',
    );
  });
  const browser = new BrowserAdapter({ proxy: "direct" });
  try {
    await browser.open(app.url);
    await assert.rejects(() => browser.refresh("Refresh activity"), /found 2/);
    await assert.rejects(() => browser.refresh("Reload list"), /found 0/);
  } finally {
    await browser.close();
    await app.close();
  }
});

test("failed locator handlers block dispatch without escaping the runner or losing the page", async () => {
  let mutations = 0;
  const app = await endpoint((q, r) => {
    if (q.url === "/apply") mutations++;
    r.setHeader("content-type", "text/html");
    r.end("<button onclick=\"fetch('/apply')\">Apply</button>");
  });
  const browser = new BrowserAdapter({ proxy: "direct", timeoutMs: 200 });
  browser.setInterruptionHandler(async () => {
    throw new HarnessError(
      "INTERRUPTION_UNRESOLVED",
      "Notice disappeared before dismissal",
    );
  });
  try {
    await browser.open(app.url);
    const action: ResolvedAction = {
      text: "Click Apply",
      operation: "click",
      target: { frame: 0, kind: "role", value: "button", name: "Apply" },
    };
    await assert.rejects(
      () => browser.prepare(action),
      /INTERRUPTION_UNRESOLVED/,
    );
    await assert.rejects(
      () => browser.execute(action),
      /INTERRUPTION_UNRESOLVED/,
    );
    assert.match((await browser.observe()).text!, /Apply/);
    assert.equal(mutations, 0);
    browser.setInterruptionHandler(async () => {});
    await browser.prepare(action);
    await browser.execute(action);
    assert.equal(mutations, 1);
  } finally {
    await browser.close();
    await app.close();
  }
});
