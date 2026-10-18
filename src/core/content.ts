import { privacyDenied } from "./privacy.js";
import { HarnessError } from "./types.js";
export type GenerateField = { prompt: string; maxChars?: number };
export type ContentOptions = {
  enabled: boolean;
  maxRequests: number;
  maxUsd: number;
  inputPerMillion: number;
  outputPerMillion: number;
  maxOutputTokens?: number;
};
export type ContentResponse = {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};
export interface ContentProvider {
  generate(
    prompt: string,
    maxOutputTokens: number,
    signal?: AbortSignal,
  ): Promise<ContentResponse>;
  close?(): Promise<void>;
}
export class FieldWriter {
  readonly usage = {
    models: [] as string[],
    inputPerMillion: null as number | null,
    outputPerMillion: null as number | null,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedUsd: 0,
    complete: true,
    cacheHits: 0,
  };
  private cache = new Map<string, ContentResponse>();
  constructor(
    private provider: ContentProvider | undefined,
    private options: ContentOptions | undefined,
    private sanitize: (s: string) => string,
    private allowed = true,
  ) {
    this.usage.inputPerMillion = options?.inputPerMillion ?? null;
    this.usage.outputPerMillion = options?.outputPerMillion ?? null;
  }
  async write(field: GenerateField, signal?: AbortSignal) {
    if (!this.allowed) privacyDenied("runtime writing");
    const o = this.options;
    if (!o?.enabled || !this.provider)
      throw new HarnessError(
        "CONTENT_PROVIDER_REQUIRED",
        "Runtime text generation requires content.enabled, explicit pricing/budgets and an injected ContentProvider or DUIT_WRITER_* configuration",
      );
    const prompt = this.sanitize(field.prompt),
      key = JSON.stringify([prompt, field.maxChars]);
    const cached = this.cache.get(key);
    if (cached) {
      this.usage.cacheHits++;
      return cached;
    }
    if (
      this.usage.requests >= o.maxRequests ||
      this.usage.estimatedUsd >= o.maxUsd
    )
      throw new HarnessError(
        "CONTENT_BUDGET_EXCEEDED",
        "Writer budget exhausted; no request or fill dispatched",
      );
    this.usage.requests++;
    let r: ContentResponse;
    try {
      r = await this.provider.generate(
        prompt,
        o.maxOutputTokens ?? 256,
        signal,
      );
    } catch (error) {
      this.usage.complete = false;
      if (error instanceof HarnessError) throw error;
      throw new HarnessError(
        "CONTENT_PROVIDER_FAILED",
        "Writer request failed; no automatic retry, no fill dispatched",
      );
    }
    if (
      ![r.inputTokens, r.outputTokens].every(
        (n) => Number.isInteger(n) && n >= 0,
      )
    ) {
      this.usage.complete = false;
      throw new HarnessError(
        "INVALID_CONTENT_RESPONSE",
        "Writer must return token usage",
      );
    }
    if (!this.usage.models.includes(r.model)) this.usage.models.push(r.model);
    this.usage.inputTokens += r.inputTokens;
    this.usage.outputTokens += r.outputTokens;
    this.usage.estimatedUsd =
      (this.usage.inputTokens * o.inputPerMillion +
        this.usage.outputTokens * o.outputPerMillion) /
      1e6;
    if (this.usage.estimatedUsd > o.maxUsd)
      throw new HarnessError(
        "CONTENT_BUDGET_EXCEEDED",
        "Writer response exceeded the estimated budget; cost is recorded, fill not dispatched",
      );
    if (
      typeof r.text !== "string" ||
      !r.text.trim() ||
      r.text.length > (field.maxChars ?? 2000)
    )
      throw new HarnessError(
        "INVALID_CONTENT_RESPONSE",
        "Generated field is empty or exceeds maxChars; fill not dispatched",
      );
    this.cache.set(key, r);
    return r;
  }
}
