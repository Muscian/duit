import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionEngine, defaultPolicy } from "../src/core/decisions.js";
import { runCase } from "../src/core/runner.js";
import { BrowserAdapter } from "../src/platforms/browser.js";
import type { DecisionProvider } from "../src/core/types.js";

const noModel: DecisionProvider = {
  async decide() {
    throw new Error("Unexpected model call");
  },
};

test("atomic canonical navigation and quoted literals compile without model interpretation", async () => {
  const e = new DecisionEngine(noModel, defaultPolicy);
  const steps = await e.compile([
    'Navigate to "https://example.com/"',
    'Enter "${PASSWORD}" in Password',
    'Verify the text "Welcome #1: ready" is visible',
    'Verify the text "Error" is not visible',
    "Click Save",
  ]);
  assert.deepEqual(
    steps.map((s) => [s.operation, s.value]),
    [
      ["goto", "https://example.com/"],
      ["fill", "${PASSWORD}"],
      ["assert_text", "Welcome #1: ready"],
      ["assert_no_text", "Error"],
      ["click", undefined],
    ],
  );
});

test("configured notices dismiss stacked overlays in actionable order and preserve unrelated confirmation", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<h1>Ready</h1><button id="next" onclick="document.querySelector('output').textContent='Reached'">Continue</button><output></output>
    <div role="dialog" aria-label="Verify Email" style="position:fixed;inset:0;background:white;z-index:10"><p>Please confirm your email address</p><button onclick="this.parentElement.remove()">Not Now</button></div>
    <div role="dialog" aria-label="Cookie privacy" style="position:fixed;inset:0;background:white;z-index:20"><p>We use cookies</p><button onclick="this.parentElement.remove()">ACCEPT ALL COOKIES</button></div>
    <button onclick="throw Error('not authorized')">Confirm deletion</button>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const root = await mkdtemp(join(tmpdir(), "duit-notices-"));
    const report = await runCase(
      {
        name: "Stacked incidental notices",
        baseUrl: url,
        variables: {},
        interaction: { cookies: "accept", reminders: "later", maxActions: 2 },
        steps: ["Click Continue", 'Verify the text "Reached" is visible'],
      },
      {
        platform: new BrowserAdapter({ proxy: "direct", timeoutMs: 1000 }),
        provider: noModel,
        artifactsDir: join(root, "run"),
        screenshots: false,
        readinessTimeoutMs: 2000,
      },
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.deepEqual(
      report.interruptions?.map((e) => e.name),
      ["Configured cookies", "Configured reminders"],
    );
    assert.equal(report.usage?.requests, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("manual notice policy never grants consent and compound prose stays model interpreted", async () => {
  const { incidentalControl } = await import("../src/core/interaction.js");
  assert.equal(
    incidentalControl(
      { url: "http://example.com", title: "test", elements: [] },
      { cookies: "manual" },
    ),
    undefined,
  );
  let requested = false;
  const engine = new DecisionEngine(
    {
      async decide() {
        requested = true;
        throw new Error("compound routed");
      },
    },
    defaultPolicy,
  );
  await assert.rejects(
    engine.compile(["Click Save and then click Apply"]),
    /compound routed/,
  );
  assert.equal(requested, true);
});

test("a covered command-palette duplicate cannot compete with a visible navigation link", async () => {
  const engine = new DecisionEngine(noModel, defaultPolicy);
  const [step] = await engine.compile(["Click Governance Strategies"]);
  const base = {
    tag: "a",
    role: "link",
    name: "Governance Strategies",
    text: "Governance Strategies",
    type: "",
    visible: true,
    disabled: false,
    context: "Governance",
    locator: {
      frame: 0,
      kind: "role" as const,
      value: "link",
      name: "Governance Strategies",
    },
  };
  const action = await engine.resolve(step, {
    url: "http://example.com",
    title: "Home",
    elements: [
      { ...base, id: "link", occluded: false },
      { ...base, id: "palette", role: "option", occluded: true },
    ],
  });
  assert.equal(action.resolution, "exact-label");
  assert.deepEqual(action.target, base.locator);
});

test("test profile can be overridden and unrecognized confirmations are never selected", async () => {
  const { incidentalControl } = await import("../src/core/interaction.js");
  const base = {
    id: "c",
    tag: "button",
    role: "button",
    name: "ACCEPT ALL COOKIES",
    text: "",
    type: "",
    visible: true,
    occluded: false,
    disabled: false,
    context: "Cookie consent",
    locator: {
      frame: 0,
      kind: "role" as const,
      value: "button",
      name: "ACCEPT ALL COOKIES",
    },
  };
  const o = { url: "http://example.com", title: "test", elements: [base] };
  assert.equal(incidentalControl(o, { profile: "test" })?.category, "cookies");
  assert.equal(
    incidentalControl(o, { profile: "test", cookies: "manual" }),
    undefined,
  );
  assert.equal(
    incidentalControl(
      { ...o, elements: [{ ...base, name: "Confirm deletion" }] },
      { profile: "test" },
    ),
    undefined,
  );
});

test("decision context is redacted and attached only to model requests", async () => {
  let state: unknown;
  const e = new DecisionEngine(
    {
      async decide(s) {
        state = s;
        throw Error("captured");
      },
    },
    defaultPolicy,
    (s) => s.replaceAll("private-value", "[REDACTED]"),
    undefined,
    "Vocabulary private-value",
  );
  await assert.rejects(
    e.compile(["Find the desired navigation control"]),
    /captured/,
  );
  assert.equal((state as { context: string }).context, "Vocabulary [REDACTED]");
});

test("exact text counts exclude hidden duplicates and preserve replay", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      "<button>Open policy<span>Open</span><span>Open</span></button><span>Open</span><span hidden>Open</span>",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const root = await mkdtemp(join(tmpdir(), "duit-count-"));
    const report = await runCase(
      {
        name: "Visible badge count",
        baseUrl: url,
        variables: {},
        steps: [
          {
            instruction: "Count visible badges",
            scope: "Open policy",
            operation: "assert_text_count",
            value: "Open",
            count: 2,
          },
        ],
      },
      {
        platform: new BrowserAdapter({ proxy: "direct", timeoutMs: 1000 }),
        provider: noModel,
        artifactsDir: join(root, "run"),
        screenshots: false,
      },
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    const { parseReplay } = await import("../src/core/replay.js");
    const { readFile } = await import("node:fs/promises");
    const replay = parseReplay(
      JSON.parse(await readFile(join(root, "run/replay.json"), "utf8")),
    );
    assert.equal(replay.actions[0].count, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a target clipped by a scrollable catalog is scrolled into view without model recovery", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      '<div style="height:100px;overflow:auto"><div style="height:180px">Catalog</div><button onclick="document.querySelector(\'output\').textContent=\'Selected\'">Select third policy</button></div><output></output><div style="opacity:0"><button>Select third policy</button></div>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const probe = new BrowserAdapter({ proxy: "direct", timeoutMs: 1000 });
    await probe.open(url);
    try {
      const o = await probe.observe();
      const candidates = o.elements.filter(
        (e) => e.name === "Select third policy" && e.role === "button",
      );
      assert.equal(candidates.find((e) => e.visible)?.occluded, false);
      assert.equal(candidates.filter((e) => e.visible).length, 1);
    } finally {
      await probe.close();
    }
    const root = await mkdtemp(join(tmpdir(), "duit-scroll-"));
    const report = await runCase(
      {
        name: "Scrollable catalog",
        baseUrl: url,
        variables: {},
        steps: [
          "Click Select third policy",
          'Verify the text "Selected" is visible',
        ],
      },
      {
        platform: new BrowserAdapter({ proxy: "direct", timeoutMs: 1000 }),
        provider: noModel,
        artifactsDir: join(root, "run"),
        screenshots: false,
        readinessTimeoutMs: 2000,
      },
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(report.usage?.requests, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a sole covered catalog label reaches trial actionability without a semantic model call", async () => {
  const engine = new DecisionEngine(noModel, defaultPolicy);
  const [step] = await engine.compile(["Click Select Header Injection"]);
  const candidate = {
    id: "card",
    tag: "button",
    role: "button",
    name: "Select Header Injection",
    text: "Header Injection",
    type: "",
    visible: true,
    occluded: true,
    disabled: false,
    context: "Open",
    locator: { frame: 0, kind: "css" as const, value: "#card" },
  };
  const action = await engine.resolve(step, {
    url: "http://example.com",
    title: "Catalog",
    elements: [candidate],
  });
  assert.deepEqual(action.target, candidate.locator);
});

test("test profile waits for late exact labels before spending a semantic model call", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      '<h1>Loading view</h1><button>Unrelated action</button><output></output><script>setTimeout(()=>{const b=document.createElement("button");b.textContent="Open catalog";b.onclick=()=>document.querySelector("output").textContent="Catalog ready";document.body.append(b)},600)</script>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const root = await mkdtemp(join(tmpdir(), "duit-late-label-"));
    const report = await runCase(
      {
        name: "Late exact label",
        baseUrl: url,
        variables: {},
        interaction: { profile: "test", exactLabelWaitMs: 1500 },
        steps: [
          "Click Open catalog",
          'Verify the text "Catalog ready" is visible',
        ],
      },
      {
        platform: new BrowserAdapter({ proxy: "direct", timeoutMs: 1000 }),
        provider: noModel,
        artifactsDir: join(root, "run"),
        screenshots: false,
        readinessTimeoutMs: 2500,
      },
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(report.usage?.requests, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("styled native checkboxes with opacity zero remain operable but hidden parent panels do not", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      `<label style="display:inline-block;position:relative;width:180px;height:35px">Select prod<input aria-label="Select prod" type="checkbox" style="position:absolute;inset:0;opacity:0;width:100%;height:100%" onchange="document.querySelector('output').textContent=this.checked?'Chosen':''"></label><output></output><div style="opacity:0"><label>Hidden stage<input type="checkbox"></label></div>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const root = await mkdtemp(join(tmpdir(), "duit-checkbox-"));
    const report = await runCase(
      {
        name: "Custom checkbox",
        baseUrl: url,
        variables: {},
        steps: [
          {
            instruction: "Select prod",
            operation: "check",
            control: { name: "Select prod", role: "checkbox" },
          },
          'Verify the text "Chosen" is visible',
        ],
      },
      {
        platform: new BrowserAdapter({ proxy: "direct", timeoutMs: 1000 }),
        provider: noModel,
        artifactsDir: join(root, "run"),
        screenshots: false,
        readinessTimeoutMs: 2000,
      },
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(report.usage?.requests, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("discard policy handles an ARIA alertdialog after cancelling a draft", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      `<button onclick="document.querySelector('[role=alertdialog]').hidden=false">Cancel</button><div role="alertdialog" hidden style="position:fixed;inset:0;background:white"><h2>Discard unsaved changes?</h2><p>You have unsaved changes that will be lost.</p><div><button>Keep Editing</button><button onclick="this.closest('[role=alertdialog]').remove();document.querySelector('output').textContent='Active Strategies'">Discard Changes</button></div></div><output></output>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const root = await mkdtemp(join(tmpdir(), "duit-discard-"));
    const report = await runCase(
      {
        name: "Discard test draft",
        baseUrl: url,
        variables: {},
        interaction: { profile: "test" },
        steps: [
          "Click Cancel",
          'Verify the text "Active Strategies" is visible',
        ],
      },
      {
        platform: new BrowserAdapter({ proxy: "direct", timeoutMs: 1000 }),
        provider: noModel,
        artifactsDir: join(root, "run"),
        screenshots: false,
        readinessTimeoutMs: 2000,
      },
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.deepEqual(
      report.interruptions?.map((e) => e.name),
      ["Configured unsaved changes"],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("late notices recover only the pending assertion and never repeat its preceding click", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      `<button onclick="window.cancels=(window.cancels||0)+1;setTimeout(()=>document.querySelector('[role=alertdialog]').hidden=false,400)">Cancel</button><div role="alertdialog" hidden style="position:fixed;inset:0;background:white"><h2>Discard unsaved changes?</h2><button onclick="this.parentElement.remove();document.querySelector('output').textContent=window.cancels===1?'Active Strategies':'Repeated Cancel'">Discard Changes</button></div><output></output>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const root = await mkdtemp(join(tmpdir(), "duit-late-dialog-"));
    const report = await runCase(
      {
        name: "Late discard dialog",
        baseUrl: url,
        variables: {},
        interaction: { profile: "test" },
        steps: [
          "Click Cancel",
          'Verify the text "Active Strategies" is visible',
        ],
      },
      {
        platform: new BrowserAdapter({ proxy: "direct", timeoutMs: 800 }),
        provider: noModel,
        artifactsDir: join(root, "run"),
        screenshots: false,
        readinessTimeoutMs: 2000,
      },
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(report.steps[1].assertionRecoveries?.length, 1);
    assert.deepEqual(report.steps[1].assertionRecoveries?.[0].notices, [
      "Configured unsaved changes",
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("compact inspection retains duplicate-label scope and scroll targets without repeating unique-control context", async () => {
  const { summarizeObservation } = await import("../src/core/inspection.js");
  const base = {
    id: "c",
    tag: "button",
    role: "button",
    name: "Select policy",
    text: "",
    type: "",
    visible: true,
    disabled: false,
    context:
      "Start " + "description ".repeat(80) + " Open: Works across all gateways",
    locator: { frame: 0, kind: "css" as const, value: "#c" },
  };
  const o = {
    url: "http://example.com/?code=sensitive",
    title: "Catalog",
    elements: [
      base,
      { ...base, id: "d", context: "Provider Native", occluded: true },
      { ...base, id: "save", name: "Save" },
      { ...base, id: "modal-blocked", name: "Apply", blockedByModal: true },
    ],
  };
  const compact = summarizeObservation(o);
  assert.equal(compact.url, "http://example.com/");
  assert.ok(
    compact.controls[0].context.endsWith("Open: Works across all gateways"),
  );
  assert.ok(compact.controls[0].context.length < 210);
  assert.equal(compact.controls.find((e) => e.name === "Save")?.context, "");
  assert.equal(
    compact.controls.some((e) => e.name === "Apply"),
    false,
  );
  assert.equal(compact.controls[1].occluded, true);
});

test("restricted reports omit recovered assertion details as well as primary errors", async () => {
  const { privateStep, resolvePrivacy } =
    await import("../src/core/privacy.js");
  const step = {
    index: 0,
    text: "Private assertion",
    status: "passed" as const,
    durationMs: 1,
    assertionRecoveries: [
      { error: "Sensitive page text", notices: ["Private notice"] },
    ],
  };
  const minimized = privateStep(step, resolvePrivacy({ mode: "restricted" }));
  assert.equal(minimized.assertionRecoveries, undefined);
  assert.equal(JSON.stringify(minimized).includes("Sensitive"), false);
  assert.equal(
    privateStep(step, resolvePrivacy({ mode: "standard" })).assertionRecoveries
      ?.length,
    1,
  );
});

test("partial menu labels and link suffixes require interpretation, never exact binding", async () => {
  const engine = new DecisionEngine(noModel, defaultPolicy);
  for (const [name, role, instruction] of [
    ["Delete all projects", "menuitem", "Click Delete"],
    ["Docs - Opens a new window", "link", "Click Docs"],
  ]) {
    await assert.rejects(
      engine.resolve(
        { text: instruction, operation: "click" },
        {
          url: "https://example.com",
          title: "Example",
          elements: [
            {
              id: "c",
              name,
              role,
              tag: "a",
              type: "",
              text: name,
              visible: true,
              disabled: false,
              context: "",
              locator: { frame: 0, kind: "css", value: "#c" },
            },
          ],
        },
      ),
      /Unexpected model call/,
    );
  }
});

test("a lone quoted control label is not mistaken for an unquoted fill value", async () => {
  const engine = new DecisionEngine(noModel, defaultPolicy);
  await assert.rejects(
    engine.compile([
      {
        instruction: 'Fill the "Address" field with synthetic text',
        operation: "fill",
      },
    ]),
    /Unexpected model call/,
  );
  await assert.rejects(
    engine.compile(["Click Save then Delete"]),
    /Unexpected model call/,
  );
});

test("compact inspection preserves unnamed controls and bounded select options", async () => {
  const { summarizeObservation } = await import("../src/core/inspection.js");
  const o = summarizeObservation({
    url: "https://example.com",
    title: "",
    elements: [
      {
        id: "c",
        tag: "select",
        role: "combobox",
        name: "",
        type: "",
        text: "",
        visible: true,
        disabled: false,
        context: "Choose destination",
        options: Array.from({ length: 35 }, (_, i) => `City ${i}`),
        locator: { frame: 0, kind: "css", value: "#c" },
      },
    ],
  });
  assert.equal(o.controls.length, 1);
  assert.equal(o.controls[0].context, "Choose destination");
  assert.equal(o.controls[0].options?.length, 30);
  assert.equal(o.controls[0].omittedOptions, 5);
});

test("nested named pointer widgets are discovered without inherited pointer duplicates", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      `<h1>Ready</h1><div onclick="document.querySelector('output').textContent='Selected'"><div class="widget" aria-label="Choose illustration" style="cursor:pointer;width:100px;height:100px"><div><span>artwork</span></div></div></div><output></output>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const root = await mkdtemp(join(tmpdir(), "duit-pointer-"));
    const report = await runCase(
      {
        name: "Nested widget",
        baseUrl: url,
        variables: {},
        steps: [
          "Click Choose illustration",
          'Verify the text "Selected" is visible',
        ],
      },
      {
        platform: new BrowserAdapter({ proxy: "direct", timeoutMs: 1000 }),
        provider: noModel,
        artifactsDir: join(root, "run"),
        screenshots: false,
      },
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("explicit repeated names constrain semantic disambiguation to matching controls", async () => {
  const provider: DecisionProvider = {
    async decide(_state, questions) {
      const q = questions.target;
      assert.deepEqual(Object.keys(q.criteria), ["a", "b", "none"]);
      return {
        model: "test",
        usage: { input_tokens: 0, output_tokens: 0 },
        answers: {
          target: {
            type: "choice",
            choice: "a",
            confidence: 1,
            probabilities: { a: 1, b: 0, none: 0 },
          },
        },
      };
    },
  };
  const e = new DecisionEngine(provider, defaultPolicy);
  const base = {
    tag: "button",
    role: "button",
    type: "",
    text: "",
    visible: true,
    disabled: false,
    context: "",
  };
  const observation = {
    url: "https://example.com",
    title: "",
    elements: [
      {
        ...base,
        id: "a",
        name: "Choose",
        context: "Flight 43",
        locator: { frame: 0, kind: "css" as const, value: "#a" },
      },
      {
        ...base,
        id: "b",
        name: "Choose",
        context: "Flight 234 at 7:43",
        locator: { frame: 0, kind: "css" as const, value: "#b" },
      },
      {
        ...base,
        id: "delete",
        name: "Delete",
        locator: { frame: 0, kind: "css" as const, value: "#delete" },
      },
    ],
  };
  const result = await e.resolve(
    {
      text: "Choose flight 43",
      operation: "click",
      control: { name: "Choose", role: "button" },
    },
    observation,
  );
  assert.equal(result.resolution, "jev");
  assert.equal(result.target?.value, "#a");
  await assert.rejects(
    e.resolve(
      { text: "Choose", operation: "click", control: { name: "Missing" } },
      observation,
    ),
    /found 0/,
  );
});

test("named regions, ancestor group names and image-only links remain usable across UI frameworks", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      `<h1>Ready</h1><div aria-label="Notification settings"><label><input type="checkbox">Send updates</label></div><div aria-label="Choose artwork" style="width:100px;height:100px" onclick="document.querySelector('output').textContent='Chosen'"><div>Art</div></div><a href="#details"><img alt="Details" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3C/svg%3E"></a><output></output>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const platform = new BrowserAdapter({ proxy: "direct", timeoutMs: 1000 });
  try {
    await platform.open(url);
    const o = await platform.observe();
    const checkbox = o.elements.find((e) => e.role === "checkbox");
    assert.ok(checkbox?.context.includes("Notification settings"));
    assert.ok(
      o.elements.some((e) => e.role === "link" && e.name === "Details"),
    );
    const e = new DecisionEngine(noModel, defaultPolicy);
    await platform.execute(
      await e.resolve({ text: "Click Choose artwork", operation: "click" }, o),
    );
    await platform.execute({
      text: "Chosen",
      operation: "assert_text",
      value: "Chosen",
    });
  } finally {
    await platform.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a nonmodal dialog cannot hide an exposed external confirmation from discovery", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      `<div role="dialog" style="position:absolute;left:0;top:0;width:100px;height:100px"><button>Close</button></div><div style="position:absolute;left:300px;top:0"><button onclick="document.querySelector('output').textContent='Confirmed'">OK</button></div><output style="position:absolute;top:150px"></output>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const root = await mkdtemp(join(tmpdir(), "duit-nonmodal-"));
    const report = await runCase(
      {
        name: "External confirmation",
        baseUrl: url,
        variables: {},
        steps: ["Click OK", 'Verify the text "Confirmed" is visible'],
      },
      {
        provider: noModel,
        platform: new BrowserAdapter({ proxy: "direct", timeoutMs: 1000 }),
        artifactsDir: join(root, "run"),
        screenshots: false,
      },
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a declared modal still excludes background controls", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      `<button>Background</button><div role="dialog" aria-modal="true" style="position:absolute;left:300px;top:0"><input aria-label="Modal control"></div>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const platform = new BrowserAdapter({ proxy: "direct" });
  try {
    await platform.open(
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
    const o = await platform.observe();
    assert.equal(
      o.elements.find((e) => e.name === "Background")?.blockedByModal,
      true,
    );
    assert.equal(
      o.elements.find((e) => e.name === "Modal control")?.modal,
      true,
    );
  } finally {
    await platform.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("forbidden subframes remain blocked without poisoning a top-level action", async () => {
  let externalRequests = 0;
  const external = createServer((_req, res) => {
    externalRequests++;
    res.end("External");
  });
  await new Promise<void>((r) => external.listen(0, "127.0.0.1", r));
  const forbidden = `http://127.0.0.1:${(external.address() as { port: number }).port}`;
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      `<button onclick="const f=document.createElement('iframe');f.src='${forbidden}';document.body.append(f);document.querySelector('output').textContent='Saved'">Save</button><output></output>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const root = await mkdtemp(join(tmpdir(), "duit-subframe-"));
    const report = await runCase(
      {
        name: "Blocked subframe",
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        variables: {},
        steps: ["Click Save", 'Verify the text "Saved" is visible'],
      },
      {
        provider: noModel,
        platform: new BrowserAdapter({ proxy: "direct", timeoutMs: 1000 }),
        artifactsDir: join(root, "run"),
        screenshots: false,
      },
    );
    assert.equal(report.status, "passed", JSON.stringify(report));
    assert.equal(externalRequests, 0);
    assert.ok(
      report.diagnostics?.events.some((e) => e.kind === "navigation_blocked"),
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => external.close(() => r()));
  }
});

test("canonical values preserve apostrophes, variable-containing URLs and assertion polarity", async () => {
  const e = new DecisionEngine(noModel, defaultPolicy);
  const steps = await e.compile([
    'Enter "O\'Reilly and team" in Name',
    'Verify the text "is not visible" is visible',
    'Navigate to "https://example.com/${PATH}"',
  ]);
  assert.deepEqual(
    steps.map((s) => [s.operation, s.value]),
    [
      ["fill", "O'Reilly and team"],
      ["assert_text", "is not visible"],
      ["goto", "https://example.com/${PATH}"],
    ],
  );
  await assert.rejects(
    e.resolve(
      steps[0],
      { url: "https://example.com", title: "", elements: [] },
      undefined,
      { semantic: false },
    ),
    /Waiting for an exact observed fill label/,
  );
});

test("field scope uses the nearest preceding section instead of unrelated sibling headings", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      `<main><h2>Shipping details</h2><form><label>City<input></label><button>Save</button></form><h2>Billing details</h2><form><label>City<input></label><button>Save</button></form></main>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const platform = new BrowserAdapter({ proxy: "direct" });
  try {
    await platform.open(
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    );
    const o = await platform.observe();
    const fields = o.elements.filter((e) => e.role === "textbox");
    assert.equal(fields.length, 2);
    assert.ok(fields[0].context.includes("Shipping details"));
    assert.ok(!fields[0].context.includes("Billing details"));
    assert.ok(fields[1].context.includes("Billing details"));
    assert.ok(!fields[1].context.includes("Shipping details"));
    const e = new DecisionEngine(noModel, defaultPolicy);
    const a = await e.resolve(
      {
        text: 'Enter "Test City" in City',
        operation: "fill",
        value: "Test City",
        scope: "Billing details",
        control: { name: "City" },
      },
      o,
    );
    assert.deepEqual(a.target, fields[1].locator);
  } finally {
    await platform.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
