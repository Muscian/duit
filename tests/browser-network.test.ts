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

test("fresh Chromium reports local-network denial and a scoped grant restores CDN-rendered sign in", async () => {
  const cdn = await endpoint((req, res) => {
    if (req.url === "/permission") {
      res.setHeader("content-type", "text/html");
      res.end(
        `<body><script>navigator.permissions.query({name:'local-network-access'}).then(p=>document.body.innerHTML='<p>'+p.state+'</p>')</script>`,
      );
      return;
    }
    if (req.url?.startsWith("/styles.css")) {
      res.setHeader("content-type", "text/css");
      res.end("body { color: rgb(1, 2, 3) }");
    } else {
      res.setHeader("content-type", "application/javascript");
      res.end(
        `document.body.innerHTML='<label>Username <input></label><button>Sign in</button>'`,
      );
    }
  });
  const app = await endpoint((req, res) => {
    if (req.url === "/permission") {
      res.setHeader("content-type", "text/html");
      res.end(
        `<body><script>navigator.permissions.query({name:'local-network-access'}).then(p=>document.body.innerHTML='<p>'+p.state+'</p>')</script>`,
      );
      return;
    }
    res.setHeader("content-type", "text/html");
    // Deterministically emulate a public page reaching a private/VPN CDN offline.
    res.setHeader("content-security-policy", "treat-as-public-address");
    res.end(
      `<head><link rel="stylesheet" href="${cdn.url}/styles.css?secret=not-for-logs"><script defer src="${cdn.url}/lib.js?secret=not-for-logs"></script></head><body></body>`,
    );
  });
  const root = await mkdtemp(join(tmpdir(), "duit-local-network-"));
  const spec = {
    name: "Local network sign in",
    baseUrl: app.url,
    variables: {},
    steps: ["Verify Sign in"],
  };
  const replay = {
    version: 1 as const,
    ...spec,
    actions: [
      {
        text: "Verify Sign in",
        operation: "assert_text" as const,
        value: "Sign in",
      },
    ],
  };
  try {
    const denied = await runCase(spec, {
      platform: new BrowserAdapter({ proxy: "direct", timeoutMs: 300 }),
      artifactsDir: join(root, "denied"),
      replay,
      screenshots: false,
    });
    assert.equal(denied.status, "blocked", JSON.stringify(denied));
    assert.match(denied.steps[0].error!, /PAGE_RESOURCES_FAILED/);
    assert(
      denied.diagnostics?.events.some(
        (e) =>
          e.kind === "browser_network_error" &&
          e.corsError === "LocalNetworkAccessPermissionDenied",
      ),
    );
    assert(!JSON.stringify(denied).includes("not-for-logs"));
    assert.match(
      await readFile(join(root, "denied/report.html"), "utf8"),
      /LocalNetworkAccessPermissionDenied/,
    );
    const granted = await runCase(spec, {
      platform: new BrowserAdapter({
        proxy: "direct",
        timeoutMs: 1000,
        localNetworkOrigins: [app.url],
      }),
      artifactsDir: join(root, "granted"),
      replay,
      screenshots: false,
    });
    assert.equal(granted.status, "passed", JSON.stringify(granted));
    assert.deepEqual(granted.diagnostics?.browser?.localNetworkOrigins, [
      app.url,
    ]);
    assert(!granted.diagnostics?.events.some((e) => e.corsError));
    // The grant belongs to the initiating page, and does not grant it to the CDN.
    const scoped = new BrowserAdapter({
      proxy: "direct",
      allowedOrigins: [cdn.url],
      localNetworkOrigins: [app.url],
      timeoutMs: 1000,
    });
    try {
      await scoped.open(app.url + "/permission");
      await scoped.execute({
        text: "Granted",
        operation: "assert_text",
        value: "granted",
      });
      await scoped.execute({
        text: "CDN",
        operation: "goto",
        value: cdn.url + "/permission",
      });
      await scoped.execute({
        text: "Not granted to CDN",
        operation: "assert_text",
        value: "prompt",
      });
    } finally {
      await scoped.close();
    }
  } finally {
    await app.close();
    await cdn.close();
  }
});

test("failed essential assets block empty-page assertions but optional failures and pre-login 401 do not", async () => {
  const app = await endpoint((req, res) => {
    if (req.url?.startsWith("/broken.js")) {
      res.writeHead(503, { "content-type": "application/javascript" });
      res.end("unavailable");
    } else if (req.url === "/profile") {
      res.writeHead(401);
      res.end("unauthorized");
    } else if (req.url === "/rendered") {
      res.setHeader("content-type", "text/html");
      res.end(
        '<h1>Sign in</h1><script src="/broken.js"></script><script>fetch("/profile")</script>',
      );
    } else {
      res.setHeader("content-type", "text/html");
      res.end('<script src="/broken.js?secret=not-for-logs"></script>');
    }
  });
  try {
    for (const operation of ["assert_text", "assert_no_text"] as const) {
      const adapter = new BrowserAdapter({
        proxy: "direct",
        timeoutMs: 100,
        navigationTimeoutMs: 150,
      });
      try {
        await adapter.open(app.url);
        await assert.rejects(
          adapter.execute({ text: "Sign in", operation, value: "Sign in" }),
          /PAGE_RESOURCES_FAILED/,
        );
        await assert.rejects(
          adapter.observe({ text: "Username", operation: "fill" }),
          /PAGE_RESOURCES_FAILED/,
        );
      } finally {
        await adapter.close();
      }
    }
    const rendered = new BrowserAdapter({ proxy: "direct", timeoutMs: 150 });
    try {
      await rendered.open(app.url + "/rendered");
      await rendered.execute({
        text: "Sign in",
        operation: "assert_text",
        value: "Sign in",
      });
      await assert.rejects(
        rendered.execute({
          text: "Missing dashboard",
          operation: "assert_text",
          value: "Dashboard",
        }),
        (e) =>
          e instanceof Error && !e.message.includes("PAGE_RESOURCES_FAILED"),
      );
      assert(rendered.diagnostics().events.some((e) => e.status === 401));
    } finally {
      await rendered.close();
    }
  } finally {
    await app.close();
  }
});

test("CORS errors include the Chromium reason and a successful reload clears stale asset failures", async () => {
  let broken = true;
  const cdn = await endpoint((_req, res) => {
    res.setHeader("content-type", "application/javascript");
    if (!broken) res.setHeader("access-control-allow-origin", "*");
    res.end(`document.body.innerHTML='<button>Sign in</button>'`);
  });
  const app = await endpoint((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      `<script type="module" src="${cdn.url}/app.js?token=not-for-logs"></script>`,
    );
  });
  const adapter = new BrowserAdapter({ proxy: "direct", timeoutMs: 200 });
  try {
    await adapter.open(app.url);
    await assert.rejects(
      adapter.execute({
        text: "Sign in",
        operation: "assert_text",
        value: "Sign in",
      }),
      /PAGE_RESOURCES_FAILED/,
    );
    assert(
      adapter
        .diagnostics()
        .events.some((e) => e.corsError === "MissingAllowOriginHeader"),
    );
    assert(!JSON.stringify(adapter.diagnostics()).includes("not-for-logs"));
    broken = false;
    await adapter.execute({
      text: "Reload",
      operation: "goto",
      value: app.url,
    });
    await adapter.execute({
      text: "Rendered",
      operation: "assert_text",
      value: "Sign in",
    });
    await adapter.execute({
      text: "No errors",
      operation: "assert_no_text",
      value: "Error",
    });
  } finally {
    await adapter.close();
    await app.close();
    await cdn.close();
  }
});

test("local-network grants and Chromium channels validate before launch", async () => {
  for (const options of [
    { browser: "firefox" as const, channel: "chrome" as const },
    { localNetworkOrigins: ["https://untrusted.example"] },
    { localNetworkOrigins: ["file:///tmp"] },
  ]) {
    const adapter = new BrowserAdapter(options);
    try {
      await assert.rejects(
        adapter.open("https://app.example"),
        /INVALID_BROWSER_OPTIONS/,
      );
    } finally {
      await adapter.close();
    }
  }
});
