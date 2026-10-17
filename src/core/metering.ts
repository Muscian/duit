import {
  HarnessError,
  type CostOptions,
  type DecisionProvider,
  type UsageSummary,
  type DecisionResponse,
  type VisualResponse,
  type ChoiceQuestion,
  type VisualFrame,
} from "./types.js";

/** Per-run accounting. Thresholds stop the next call; an in-flight call can exceed them. */
export class MeteredProvider implements DecisionProvider {
  readonly usage: UsageSummary = {
    requests: 0,
    failedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedUsd: 0,
    pricingSource:
      "https://docs.typesafe.ai/models (2026-10-17); estimate from returned usage, not an invoice",
    inputPerMillion: 0.042,
    outputPerMillion: 0,
    complete: true,
  };
  locate?: DecisionProvider["locate"];
  constructor(
    private provider: DecisionProvider,
    private limits: CostOptions = {},
  ) {
    if (
      limits.inputPerMillion !== undefined ||
      limits.outputPerMillion !== undefined
    ) {
      if (
        limits.inputPerMillion === undefined ||
        limits.outputPerMillion === undefined
      )
        throw new HarnessError(
          "INVALID_PRICING",
          "Set both inputPerMillion and outputPerMillion",
        );
      this.usage.inputPerMillion = limits.inputPerMillion;
      this.usage.outputPerMillion = limits.outputPerMillion;
      this.usage.pricingSource =
        "Caller-configured USD per million tokens; estimate, not an invoice";
    }
    if (provider.locate)
      this.locate = (
        frame: VisualFrame,
        instruction: string,
        signal?: AbortSignal,
      ) => this.call(() => provider.locate!(frame, instruction, signal));
  }
  private async call<T extends DecisionResponse | VisualResponse>(
    fn: () => Promise<T>,
  ): Promise<T> {
    const u = this.usage,
      l = this.limits;
    if (
      (l.maxRequests !== undefined && u.requests >= l.maxRequests) ||
      (l.maxInputTokens !== undefined && u.inputTokens >= l.maxInputTokens) ||
      (l.maxUsd !== undefined &&
        (u.estimatedUsd === null || u.estimatedUsd >= l.maxUsd))
    )
      throw new HarnessError(
        "COST_BUDGET_EXCEEDED",
        "Decision budget reached; no further model call was sent. Inspect resource state before rerunning.",
      );
    u.requests++;
    try {
      const r = await fn();
      u.inputTokens += r.usage.input_tokens;
      u.outputTokens += r.usage.output_tokens;
      if (
        !/^jev-1\.(13|14)\.0$/.test(r.model) &&
        l.inputPerMillion === undefined
      ) {
        u.inputPerMillion = u.outputPerMillion = u.estimatedUsd = null;
        u.pricingSource = `Unknown rate for ${r.model}; configure both per-million rates`;
      }
      if (u.estimatedUsd !== null)
        u.estimatedUsd =
          (u.inputTokens * u.inputPerMillion! +
            u.outputTokens * u.outputPerMillion!) /
          1_000_000;
      return r;
    } catch (error) {
      u.failedRequests++;
      u.complete = false;
      throw error;
    }
  }
  decide(
    state: unknown,
    questions: Record<string, ChoiceQuestion>,
    signal?: AbortSignal,
  ) {
    return this.call(() => this.provider.decide(state, questions, signal));
  }
}
