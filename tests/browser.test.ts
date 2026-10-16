import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserAdapter } from "../src/platforms/browser.js";
import { startShop } from "../examples/shop/server.js";
import { runCase } from "../src/core/runner.js";
import { parseReplay } from "../src/core/replay.js";
import { type ResolvedAction } from "../src/core/types.js";

test("real browser actions, assertions, masked screenshots and replay need no model", async () => {
  const shop = await startShop(0),
    root = await mkdtemp(join(tmpdir(), "duit-browser-"));
  const target = (value: string) => ({
    frame: 0,
    kind: "label" as const,
    value,
  });
  const actions: ResolvedAction[] = [
    {
      text: "Email",
      operation: "fill",
      value: "ana@example.com",
      target: target("Correo electrónico"),
    },
    {
      text: "Password",
      operation: "fill",
      value: "demo123",
      target: target("Contraseña"),
    },
    {
      text: "Login",
      operation: "click",
      target: {
        frame: 0,
        kind: "role",
        value: "button",
        name: "Iniciar sesión",
      },
    },
    { text: "Welcome", operation: "assert_text", value: "Bienvenida, Ana" },
    {
      text: "Add notebook",
      operation: "click",
      target: { frame: 0, kind: "testId", value: "add-notebook" },
    },
    {
      text: "Address",
      operation: "fill",
      value: "Corrientes 1234",
      target: target("Dirección"),
    },
    {
      text: "Address exact",
      operation: "assert_value",
      value: "Corrientes 1234",
      target: target("Dirección"),
    },
    {
      text: "Shipping",
      operation: "select",
      value: "Express",
      target: target("Método de envío"),
    },
    {
      text: "Disabled",
      operation: "assert_disabled",
      target: {
        frame: 0,
        kind: "role",
        value: "button",
        name: "Confirmar pedido",
      },
    },
    {
      text: "Terms",
      operation: "check",
      target: target("Acepto los términos"),
    },
    {
      text: "Checked",
      operation: "assert_checked",
      target: target("Acepto los términos"),
    },
    {
      text: "Submit",
      operation: "click",
      target: {
        frame: 0,
        kind: "role",
        value: "button",
        name: "Confirmar pedido",
      },
    },
    {
      text: "Async confirmation",
      operation: "assert_text",
      value: "Pedido confirmado",
    },
    {
      text: "No error",
      operation: "assert_no_text",
      value: "Credenciales incorrectas",
    },
  ];
  const spec = {
    name: "Browser replay",
    baseUrl: shop.url,
    variables: {},
    steps: actions.map((a) => a.text),
  };
  try {
    const report = await runCase(spec, {
      platform: new BrowserAdapter({ timeoutMs: 1500 }),
      artifactsDir: join(root, "run"),
      replay: { version: 1, ...spec, actions },
    });
    assert.equal(
      report.status,
      "passed",
      JSON.stringify(report.steps.find((s) => s.error)),
    );
    assert.equal(report.decisions.length, 0);
    assert.equal(report.steps.length, actions.length);
    assert.equal(
      parseReplay(
        JSON.parse(await readFile(join(root, "run/replay.json"), "utf8")),
      ).actions.length,
      actions.length,
    );
    const bad = await runCase(
      { ...spec, steps: ["Impossible assertion"] },
      {
        platform: new BrowserAdapter({ timeoutMs: 150 }),
        artifactsDir: join(root, "bad"),
        screenshots: false,
        replay: {
          version: 1,
          ...spec,
          actions: [
            {
              text: "Impossible",
              operation: "assert_text",
              value: "Payment accepted incorrectly",
            },
          ],
        },
      },
    );
    assert.equal(bad.status, "failed");
    assert.match(bad.steps[0].error!, /Expected exact text/);
  } finally {
    await shop.close();
  }
});
test("DOM observation covers iframe and open shadow roots; navigation stays within allowed origins", async () => {
  const html = `<h1>Controls</h1><label>Name <input id="name"></label><button>Save</button><button disabled>Disabled</button><button hidden>Hidden</button><div id="host"></div><iframe srcdoc="<button>Frame action</button>"></iframe><script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<button>Shadow action</button>'</script>`;
  const server = createServer((_q, r) => {
    r.end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number },
    adapter = new BrowserAdapter({ timeoutMs: 1000 });
  try {
    await adapter.open(`http://127.0.0.1:${address.port}`);
    const o = await adapter.observe();
    assert(o.elements.find((e) => e.name === "Name" && e.tag === "input"));
    assert(o.elements.find((e) => e.name === "Shadow action"));
    assert(
      o.elements.find(
        (e) => e.name === "Frame action" && e.locator.frame === 1,
      ),
    );
    assert(o.elements.find((e) => e.name === "Disabled" && e.disabled));
    assert(o.elements.find((e) => e.name === "Hidden" && !e.visible));
    await assert.rejects(
      adapter.execute({
        text: "go elsewhere",
        operation: "goto",
        value: "https://example.org",
      }),
      /NAVIGATION_BLOCKED/,
    );
    await assert.rejects(
      adapter.execute({
        text: "Duplicate CSS",
        operation: "click",
        target: { frame: 0, kind: "css", value: "button" },
      }),
    );
  } finally {
    await adapter.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
