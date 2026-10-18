import {
  HarnessError,
  type DecisionProvider,
  type RunReport,
  type StepResult,
} from "./types.js";

export type PrivacyMode = "standard" | "restricted" | "local";
export type PrivacyOptions = { mode?: PrivacyMode; redact?: string[] };
export type PrivacyPolicy = {
  mode: PrivacyMode;
  externalModels: boolean;
  images: boolean;
  writer: boolean;
  detailedArtifacts: boolean;
};
const levels = { standard: 0, restricted: 1, local: 2 };
/** The process policy is a floor: an API/MCP case cannot relax it. */
export function resolvePrivacy(input?: PrivacyOptions): PrivacyPolicy {
  const enforced = process.env.DUIT_PRIVACY_MODE ?? "standard";
  if (!Object.hasOwn(levels, enforced))
    throw new HarnessError(
      "INVALID_PRIVACY_POLICY",
      "DUIT_PRIVACY_MODE must be standard, restricted or local",
    );
  const mode =
    levels[enforced as PrivacyMode] > levels[input?.mode ?? "standard"]
      ? (enforced as PrivacyMode)
      : (input?.mode ?? "standard");
  return {
    mode,
    externalModels: mode !== "local",
    images: mode === "standard",
    writer: mode === "standard",
    detailedArtifacts: mode === "standard",
  };
}
export function privacyDenied(capability: string): never {
  throw new HarnessError(
    "PRIVACY_POLICY_BLOCKED",
    `Privacy policy prohibits ${capability}; use explicit steps or an approved configuration`,
  );
}
export function privateProvider(
  provider: DecisionProvider,
  policy: PrivacyPolicy,
): DecisionProvider {
  return {
    decide: (...args) => {
      if (!policy.externalModels) privacyDenied("model requests");
      return provider.decide(...args);
    },
    locate: provider.locate
      ? (...args) => {
          if (!policy.images) privacyDenied("image requests");
          return provider.locate!(...args);
        }
      : undefined,
  };
}
/** Allowlist provider destinations in managed runners. Redirects must never forward data elsewhere. */
export function checkModelEndpoint(endpoint: string) {
  const u = new URL(endpoint);
  if (
    u.username ||
    u.password ||
    u.hash ||
    u.search ||
    !["http:", "https:"].includes(u.protocol)
  )
    throw new HarnessError(
      "INVALID_ENDPOINT",
      "Model endpoints cannot include credentials, query parameters or fragments",
    );
  const allowed = process.env.DUIT_MODEL_ALLOWED_ORIGINS;
  if (allowed !== undefined) {
    const origins = allowed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!origins.includes(u.origin)) privacyDenied("this model endpoint");
  }
}
/** Restrict retained/returned evidence without altering execution state. */
export function privateStep(
  step: StepResult,
  policy?: PrivacyPolicy,
): StepResult {
  if (!policy || policy.detailedArtifacts) return step;
  const {
    evidence: _e,
    screenshot: _s,
    visualScreenshot: _v,
    action,
    error,
    ...rest
  } = step;
  return {
    ...rest,
    text: "[instruction omitted by privacy policy]",
    error: error
      ? (step.failure?.summary ?? "Step did not complete")
      : undefined,
    action: action
      ? {
          text: "[omitted]",
          operation: action.operation,
          resolution: action.resolution,
        }
      : undefined,
  };
}
export function privateReport(report: RunReport): RunReport {
  if (!report.privacy || report.privacy.detailedArtifacts) return report;
  return {
    ...report,
    name: "DUIT private run",
    error: report.error
      ? (report.agent?.failures[0]?.summary ?? "Run did not complete")
      : undefined,
    warnings: report.warnings.map(
      () => "A runtime warning was recorded; consult the structured outcome",
    ),
    screenshot: undefined,
    steps: report.steps.map((s) => privateStep(s, report.privacy)),
    cleanup: report.cleanup?.map((s) => privateStep(s, report.privacy)),
    decisions: report.decisions.map(({ phase, durationMs, response }) => ({
      phase,
      durationMs,
      response: { ...response, answers: {} },
    })),
    visualDecisions: [],
    interruptions: report.interruptions?.map((e) => ({
      name: "[omitted]",
      dispatched: e.dispatched,
      action: { text: "[omitted]", operation: e.action.operation },
      url: "[omitted]",
      status: e.status,
      error: e.error ? "Interruption did not complete" : undefined,
    })),
    diagnostics: report.diagnostics
      ? {
          events: report.diagnostics.events.map((e) => ({
            ...e,
            url: "[omitted]",
            message: undefined,
          })),
        }
      : undefined,
  };
}
