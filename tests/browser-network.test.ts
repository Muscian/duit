import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserConnection } from "../src/platforms/browser-network.js";
import { BrowserAdapter } from "../src/platforms/browser.js";
import { runCase } from "../src/core/runner.js";

function proxyEnv(values: Record<string, string>, work: () => void) {
  const keys = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "DUIT_BROWSER_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
  try {
    work();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}
async function endpoint(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("browser proxy selection inherits the environment, respects NO_PROXY, and supports explicit overrides", () => {
  proxyEnv(
    {
      HTTPS_PROXY: "http://user:secret@proxy.example:8080",
      HTTP_PROXY: "http://http-proxy.example:8081",
      NO_PROXY: ".internal.example,example.com:8443",
    },
    () => {
      const https = browserConnection("https://public.example/signin");
      assert.equal(https.proxy?.server, "http://proxy.example:8080");
      assert.equal(https.proxy?.username, "user");
      assert.equal(https.proxy?.password, "secret");
      assert(!JSON.stringify(https.connection).includes("secret"));
      assert.equal(
        browserConnection("http://public.example").proxy?.server,
        "http://http-proxy.example:8081",
      );
      assert.equal(
        browserConnection("https://login.internal.example").connection.mode,
        "direct",
      );
      assert.equal(
        browserConnection("https://example.com:8443").connection.mode,
        "direct",
      );
      assert.equal(
        browserConnection("https://example.com").connection.mode,
        "proxy",
      );
      assert.equal(
        browserConnection("https://public.example", "direct").connection.mode,
        "direct",
      );
      assert.equal(
        browserConnection(
          "https://public.example",
          "http://explicit.example:9000",
        ).connection.source,
        "option",
      );
    },
  );
  proxyEnv(
    {
      HTTPS_PROXY: "http://inherited:8080",
      DUIT_BROWSER_PROXY: "http://dedicated:8081",
    },
    () => {
      assert.equal(
        browserConnection("https://public.example").proxy?.server,
        "http://dedicated:8081",
      );
    },
  );
  proxyEnv({ HTTPS_PROXY: "http://proxy:8080", NO_PROXY: "*" }, () =>
    assert.equal(
      browserConnection("https://public.example").connection.mode,
      "direct",
    ),
  );
  assert.throws(
    () => browserConnection("https://public.example", "not-a-url"),
    /INVALID_PROXY/,
  );
  assert.equal(
    browserConnection("https://public.example", "socks5://proxy:1080").proxy
      ?.server,
    "socks5://proxy:1080",
  );
});

test("Chromium actually uses an inherited HTTP proxy without --proxy", async () => {
  const requests: string[] = [];
  const proxy = await endpoint((req, res) => {
    requests.push(req.url ?? "");
    res.setHeader("content-type", "text/html");
    res.end("<title>Proxy application</title><label>Username <input></label>");
  });
  const previous = process.env.HTTP_PROXY,
    previousLower = process.env.http_proxy;
  process.env.HTTP_PROXY = proxy.url;
  delete process.env.http_proxy;
  const adapter = new BrowserAdapter({ navigationTimeoutMs: 5000 });
  try {
    await adapter.open("http://duit-proxy.test/signin");
    assert(
      (
        await adapter.observe({ text: "Enter username", operation: "fill" })
      ).elements.some((e) => e.name === "Username"),
    );
    assert(requests.some((url) => url === "http://duit-proxy.test/signin"));
    assert.equal(adapter.diagnostics().connection?.source, "environment");
  } finally {
    await adapter.close();
    await proxy.close();
    if (previous === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = previous;
    if (previousLower === undefined) delete process.env.http_proxy;
    else process.env.http_proxy = previousLower;
  }
});

test("SPA controls render after DOMContentLoaded and are awaited before the first decision", async () => {
  const app = await endpoint((_q, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<title>Delayed application</title><main id="app">Loading…</main><script>
      setTimeout(()=>{document.querySelector('#app').innerHTML='<label>Username <input name="username"></label><label>Password <input type="password"></label><button>Sign in</button>';},600);
    </script>`);
  });
  const adapter = new BrowserAdapter({
    proxy: "direct",
    navigationTimeoutMs: 2000,
  });
  try {
    await adapter.open(app.url);
    const start = performance.now();
    const observation = await adapter.observe({
      text: "Enter username",
      operation: "fill",
    });
    assert(observation.elements.some((e) => e.name === "Username"));
    assert(
      performance.now() - start >= 300,
      "Observation must wait for the delayed controls",
    );
  } finally {
    await adapter.close();
    await app.close();
  }
});

test("missing SPA controls fail with readiness diagnosis; closing the adapter interrupts the wait", async () => {
  const app = await endpoint((_q, res) => res.end("<h1>Loading</h1>"));
  const adapter = new BrowserAdapter({
    proxy: "direct",
    navigationTimeoutMs: 150,
  });
  try {
    await adapter.open(app.url);
    await assert.rejects(
      adapter.observe({ text: "Enter username", operation: "fill" }),
      /PAGE_NOT_READY/,
    );
  } finally {
    await adapter.close();
  }
  const cancelled = new BrowserAdapter({
    proxy: "direct",
    navigationTimeoutMs: 30000,
  });
  try {
    await cancelled.open(app.url);
    const pending = cancelled.observe({
      text: "Enter username",
      operation: "fill",
    });
    const outcome = assert.rejects(pending);
    await cancelled.close();
    await outcome;
  } finally {
    await cancelled.close();
    await app.close();
  }
});

test("failed proxy connections and initial HTTP failures produce blocked reports with bounded, scrubbed diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "duit-network-"));
  const unreachable = await endpoint((_q, r) => r.end("unused"));
  await unreachable.close();
  const run = async (name: string, url: string, platform: BrowserAdapter) =>
    runCase(
      {
        name,
        baseUrl: url,
        steps: ["Verify expected dashboard"],
        variables: {},
      },
      {
        platform,
        artifactsDir: join(root, name),
        screenshots: false,
        replay: {
          version: 1,
          name,
          baseUrl: url,
          variables: {},
          actions: [
            {
              text: "Verify dashboard",
              operation: "assert_text",
              value: "Dashboard",
            },
          ],
        },
      },
    );
  const disconnected = await run(
    "proxy",
    "http://duit-proxy.test/signin?token=not-for-logs",
    new BrowserAdapter({ proxy: unreachable.url, navigationTimeoutMs: 1000 }),
  );
  assert.equal(disconnected.status, "blocked");
  assert.match(disconnected.error!, /BROWSER_CONNECTION_FAILED/);
  assert(
    disconnected.diagnostics?.events.some((e) => e.kind === "request_failed"),
  );
  assert(!JSON.stringify(disconnected.diagnostics).includes("not-for-logs"));
  const app = await endpoint((_q, res) => {
    res.writeHead(503);
    res.end("Dashboard");
  });
  try {
    const failed = await run(
      "http",
      app.url,
      new BrowserAdapter({ proxy: "direct" }),
    );
    assert.equal(failed.status, "blocked");
    assert.match(failed.error!, /HTTP_NAVIGATION_ERROR.*503/);
    const stored = JSON.parse(
      await readFile(join(root, "http/report.json"), "utf8"),
    );
    assert(
      stored.diagnostics.events.some(
        (e: { status: number }) => e.status === 503,
      ),
    );
    assert.match(
      await readFile(join(root, "http/report.html"), "utf8"),
      /Connection and network diagnostics/,
    );
  } finally {
    await app.close();
  }
});
