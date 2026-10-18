import {
  checkModelEndpoint,
  resolvePrivacy,
  privacyDenied,
} from "../core/privacy.js";
import "../load-env.js";
import { fetch, EnvHttpProxyAgent } from "undici";
import { z } from "zod";
import type { ContentProvider } from "../core/content.js";
import { HarnessError } from "../core/types.js";

/** Optional writer only. No tools, page context, action selection, retries or assertion judging. */
export class OpenAIContentProvider implements ContentProvider {
  private dispatcher = new EnvHttpProxyAgent();
  private options: { endpoint: string; apiKey: string; model: string };
  constructor(
    options: Partial<{ endpoint: string; apiKey: string; model: string }> = {},
  ) {
    this.options = {
      endpoint: options.endpoint ?? process.env.DUIT_WRITER_ENDPOINT ?? "",
      apiKey: options.apiKey ?? process.env.DUIT_WRITER_API_KEY ?? "",
      model: options.model ?? process.env.DUIT_WRITER_MODEL ?? "",
    };
    if (!this.options.endpoint || !this.options.apiKey || !this.options.model)
      throw new HarnessError(
        "CONTENT_PROVIDER_REQUIRED",
        "Configure DUIT_WRITER_ENDPOINT (full chat/completions URL), DUIT_WRITER_API_KEY and DUIT_WRITER_MODEL",
      );
    checkModelEndpoint(this.options.endpoint);
    const u = new URL(this.options.endpoint);
    if (
      u.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
    )
      throw new HarnessError(
        "INVALID_ENDPOINT",
        "Writer endpoint requires HTTPS",
      );
  }
  async generate(
    prompt: string,
    maxOutputTokens: number,
    signal?: AbortSignal,
  ) {
    if (!resolvePrivacy().writer) privacyDenied("runtime writing");
    const res = await fetch(this.options.endpoint, {
      method: "POST",
      redirect: "manual",
      dispatcher: this.dispatcher,
      signal: AbortSignal.any([
        AbortSignal.timeout(30000),
        ...(signal ? [signal] : []),
      ]),
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        max_tokens: maxOutputTokens,
        messages: [
          {
            role: "system",
            content:
              "Write only the requested test field value as plain text. No explanation, markdown fencing, tools, instructions for the harness, or browser actions.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new HarnessError("CONTENT_HTTP_ERROR", `Writer HTTP ${res.status}`);
    }
    const result = z
      .object({
        model: z.string(),
        choices: z
          .array(z.object({ message: z.object({ content: z.string() }) }))
          .min(1),
        usage: z.object({
          prompt_tokens: z.number().int().nonnegative(),
          completion_tokens: z.number().int().nonnegative(),
        }),
      })
      .parse(await res.json());
    return {
      text: result.choices[0].message.content,
      model: result.model,
      inputTokens: result.usage.prompt_tokens,
      outputTokens: result.usage.completion_tokens,
    };
  }
  async close() {
    await this.dispatcher.close();
  }
}
export function lazyWriter(): ContentProvider {
  let p: OpenAIContentProvider | undefined;
  return {
    generate: (...args) =>
      (p ??= new OpenAIContentProvider()).generate(...args),
    close: async () => {
      await p?.close();
    },
  };
}
