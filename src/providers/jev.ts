import { fetch, EnvHttpProxyAgent } from "undici";
import { z } from "zod";
import {
  HarnessError,
  type ChoiceQuestion,
  type DecisionProvider,
  type DecisionResponse,
} from "../core/types.js";

const probability = z.number().finite().min(0).max(1);
const responseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(
    z.string(),
    z.object({
      type: z.literal("choice"),
      choice: z.string(),
      confidence: probability,
      probabilities: z.record(z.string(), probability),
    }),
  ),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});
export function validateResponse(
  raw: unknown,
  questions: Record<string, ChoiceQuestion>,
): DecisionResponse {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success)
    throw new HarnessError(
      "INVALID_MODEL_RESPONSE",
      "Jev returned an invalid response schema",
    );
  const result = parsed.data;
  for (const [id, q] of Object.entries(questions)) {
    const a = result.answers[id];
    if (!a || !Object.hasOwn(q.criteria, a.choice))
      throw new HarnessError(
        "INVALID_MODEL_RESPONSE",
        `Missing or unknown choice for ${id}`,
      );
    const keys = Object.keys(a.probabilities);
    if (
      keys.length !== Object.keys(q.criteria).length ||
      keys.some((k) => !Object.hasOwn(q.criteria, k))
    )
      throw new HarnessError(
        "INVALID_MODEL_RESPONSE",
        `Invalid distribution for ${id}`,
      );
    const total = Object.values(a.probabilities).reduce((x, y) => x + y, 0);
    if (
      Math.abs(total - 1) > 0.02 ||
      a.probabilities[a.choice] <
        Math.max(...Object.values(a.probabilities)) - 1e-6
    )
      throw new HarnessError(
        "INVALID_MODEL_RESPONSE",
        `Inconsistent distribution for ${id}`,
      );
  }
  return result;
}
export type JevOptions = {
  apiKey?: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  retries?: number;
};
export class JevProvider implements DecisionProvider {
  private readonly options: Required<JevOptions>;
  private readonly dispatcher = new EnvHttpProxyAgent();
  constructor(options: JevOptions = {}) {
    this.options = {
      apiKey: options.apiKey ?? process.env.JEV_API_KEY ?? "",
      model: options.model ?? process.env.JEV_MODEL ?? "jev-1.14.0",
      endpoint:
        options.endpoint ??
        process.env.JEV_ENDPOINT ??
        "https://api.typesafe.ai/v1/systemone",
      timeoutMs: options.timeoutMs ?? 30_000,
      retries: options.retries ?? 2,
    };
    if (!this.options.apiKey)
      throw new HarnessError(
        "MISSING_API_KEY",
        "Set JEV_API_KEY before running live tests",
      );
    const url = new URL(this.options.endpoint);
    if (
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw new HarnessError("INVALID_ENDPOINT", "Jev endpoint must use HTTPS");
  }
  async decide(
    state: unknown,
    questions: Record<string, ChoiceQuestion>,
    signal?: AbortSignal,
  ): Promise<DecisionResponse> {
    for (let attempt = 0; attempt <= this.options.retries; attempt++) {
      signal?.throwIfAborted();
      let retryMs = Math.min(500 * 2 ** attempt, 5000);
      try {
        const res = await fetch(this.options.endpoint, {
          method: "POST",
          dispatcher: this.dispatcher,
          signal: AbortSignal.any([
            AbortSignal.timeout(this.options.timeoutMs),
            ...(signal ? [signal] : []),
          ]),
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: this.options.model, state, questions }),
        });
        if (res.ok) return validateResponse(await res.json(), questions);
        await res.body?.cancel();
        if (
          ![408, 429, 500, 502, 503, 504, 529].includes(res.status) ||
          attempt === this.options.retries
        )
          throw new HarnessError(
            "JEV_HTTP_ERROR",
            `Jev API returned HTTP ${res.status}`,
          );
        const header = res.headers.get("retry-after");
        if (header)
          retryMs = Math.min(
            10_000,
            Math.max(
              retryMs,
              Number(header) * 1000 || Date.parse(header) - Date.now() || 0,
            ),
          );
      } catch (error) {
        if (error instanceof HarnessError) throw error;
        signal?.throwIfAborted();
        if (attempt === this.options.retries)
          throw new HarnessError(
            "JEV_CONNECTION_ERROR",
            "Jev request failed or timed out; check endpoint, proxy and connectivity",
          );
      }
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(done, retryMs);
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    throw new HarnessError("JEV_RETRY_EXHAUSTED", "Jev retry budget exhausted");
  }
  async close() {
    await this.dispatcher.close();
  }
}
