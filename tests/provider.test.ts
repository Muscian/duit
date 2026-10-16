import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { JevProvider } from "../src/providers/jev.js";
const questions = {
  q: {
    type: "choice" as const,
    instructions: "Pick",
    criteria: { a: "A", b: "B" },
  },
};
const response = {
  model: "jev-test",
  usage: { input_tokens: 10, output_tokens: 1 },
  answers: {
    q: {
      type: "choice",
      choice: "a",
      confidence: 1,
      probabilities: { a: 1, b: 0 },
    },
  },
};
async function endpoint(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/systemone`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
test("Jev transport uses the documented contract and retries rate limits only within budget", async () => {
  let count = 0;
  const api = await endpoint((req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-key");
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = JSON.parse(data);
      assert.equal(body.model, "jev-1.14.0");
      assert.deepEqual(body.questions, questions);
      if (++count === 1) {
        res.writeHead(429, { "retry-after": "0" });
        res.end("{}");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(response));
    });
  });
  const provider = new JevProvider({ apiKey: "test-key", endpoint: api.url });
  try {
    assert.equal(
      (await provider.decide("state", questions)).answers.q.choice,
      "a",
    );
    assert.equal(count, 2);
  } finally {
    await provider.close();
    await api.close();
  }
});
test("authentication failures do not retry or echo response bodies/secrets", async () => {
  let count = 0;
  const api = await endpoint((_req, res) => {
    count++;
    res.writeHead(401);
    res.end("secret-key-echo");
  });
  const provider = new JevProvider({ apiKey: "test-key", endpoint: api.url });
  try {
    await assert.rejects(
      provider.decide("state", questions),
      (e) =>
        e instanceof Error &&
        e.message === "JEV_HTTP_ERROR: Jev API returned HTTP 401",
    );
    assert.equal(count, 1);
  } finally {
    await provider.close();
    await api.close();
  }
});
test("transport abort and invalid model payloads fail closed", async () => {
  const api = await endpoint((_req, res) =>
    res.end(JSON.stringify({ ...response, answers: {} })),
  );
  const provider = new JevProvider({ apiKey: "test-key", endpoint: api.url });
  try {
    await assert.rejects(
      provider.decide("state", questions),
      /INVALID_MODEL_RESPONSE/,
    );
    const controller = new AbortController();
    controller.abort(new Error("Cancelled"));
    await assert.rejects(
      provider.decide("state", questions, controller.signal),
      /Cancelled/,
    );
  } finally {
    await provider.close();
    await api.close();
  }
});
