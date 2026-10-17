import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  caseJsonSchema,
  materializeFields,
  validateCase,
} from "../core/authoring.js";
import { stepSchema } from "../core/input.js";
import { HarnessError } from "../core/types.js";
import type { DuitService } from "./service.js";

async function body(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024)
      throw new HarnessError("BODY_TOO_LARGE", "Maximum request size is 1 MiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
/** Loopback-only, bearer-authenticated local API. No browser CORS or arbitrary artifact-file access. */
export async function startHttp(
  service: DuitService,
  options: { port?: number; token?: string } = {},
) {
  const token = options.token ?? randomBytes(32).toString("hex");
  if (token.length < 16)
    throw new Error("API token must contain at least 16 characters");
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    const provided = Buffer.from(req.headers.authorization ?? ""),
      expected = Buffer.from(`Bearer ${token}`);
    if (
      req.headers.origin ||
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1"),
        parts = url.pathname.split("/").filter(Boolean);
      let result: unknown;
      if (req.method === "GET" && url.pathname === "/v1/health")
        result = service.capabilities();
      else if (req.method === "GET" && url.pathname === "/v1/schema")
        result = caseJsonSchema();
      else if (req.method === "POST" && url.pathname === "/v1/validate")
        result = validateCase(await body(req));
      else if (req.method === "POST" && url.pathname === "/v1/materialize") {
        const b = await body(req);
        result = materializeFields(b.case, b.fields);
      } else if (req.method === "POST" && url.pathname === "/v1/runs") {
        result = service.startRun(await body(req));
        res.statusCode = 202;
      } else if (
        parts[0] === "v1" &&
        parts[1] === "runs" &&
        parts.length === 3 &&
        req.method === "GET"
      )
        result = service.getRun(
          parts[2],
          url.searchParams.get("details") === "true",
        );
      else if (
        parts[0] === "v1" &&
        parts[1] === "runs" &&
        parts[3] === "cancel" &&
        parts.length === 4 &&
        req.method === "POST"
      )
        result = service.cancelRun(parts[2]);
      else if (req.method === "POST" && url.pathname === "/v1/sessions")
        result = await service.openSession(await body(req));
      else if (
        parts[0] === "v1" &&
        parts[1] === "sessions" &&
        parts.length === 4
      ) {
        const [, , id, action] = parts;
        if (req.method === "GET" && action === "inspect")
          result = await service.inspect(id);
        else if (req.method === "GET" && action === "screenshot")
          result = await service.screenshot(id);
        else if (req.method === "POST" && action === "close")
          result = await service.closeSession(id);
        else if (
          req.method === "POST" &&
          ["steps", "retry", "confirm"].includes(action)
        ) {
          const b = await body(req);
          const step =
            b.step === undefined ? undefined : stepSchema.parse(b.step);
          if (action === "retry") result = await service.retry(id, step);
          else {
            if (!step) throw new Error("step is required");
            result =
              action === "steps"
                ? await service.step(id, step)
                : await service.confirm(id, step);
          }
        } else throw new HarnessError("NOT_FOUND", "Unknown route");
      } else throw new HarnessError("NOT_FOUND", "Unknown route");
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode =
        error instanceof HarnessError && error.code === "NOT_FOUND"
          ? 404
          : error instanceof HarnessError && /BUSY|CAPACITY/.test(error.code)
            ? 409
            : 400;
      // Never echo request bodies or raw transport errors containing credentials.
      res.end(
        JSON.stringify({
          error: error instanceof HarnessError ? error.code : "INVALID_REQUEST",
          message:
            error instanceof HarnessError
              ? error.message
              : "Invalid request; validate against /v1/schema",
        }),
      );
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4318, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    token,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await service.close();
    },
  };
}
