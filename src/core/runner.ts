import "../load-env.js";
import { mkdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { caseSchema, redactor, resolveVariables, substitute } from "./input.js";
import {
  DecisionEngine,
  defaultPolicy,
  type DecisionPolicy,
} from "./decisions.js";
import { saveArtifacts, type ReplayPlan } from "./artifacts.js";
import {
  HarnessError,
  type CaseSpec,
  type DecisionProvider,
  type PlatformAdapter,
  type ResolvedAction,
  type RunReport,
  type StepResult,
} from "./types.js";

export type RunOptions = {
  provider?: DecisionProvider;
  platform: PlatformAdapter;
  artifactsDir?: string;
  policy?: Partial<DecisionPolicy>;
  signal?: AbortSignal;
  requireAssertions?: boolean;
  maxDurationMs?: number;
  screenshots?: boolean;
  onStep?: (step: StepResult) => void;
  replay?: ReplayPlan;
};
export async function runCase(
  input: CaseSpec,
  options: RunOptions,
): Promise<RunReport> {
  const spec = caseSchema.parse(input);
  const artifactsDir = resolve(
    options.artifactsDir ??
      join(
        "artifacts",
        new Date().toISOString().replace(/[:.]/g, "-") +
          "-" +
          randomUUID().slice(0, 8),
      ),
  );
  // Unique destination prevents a failed run from leaving an old successful replay artifact.
  await mkdir(dirname(artifactsDir), { recursive: true });
  await mkdir(artifactsDir, { recursive: false });
  const started = performance.now();
  const report: RunReport = {
    version: 1,
    name: spec.name,
    mode: options.replay ? "replay" : "live",
    status: "blocked",
    startedAt: new Date().toISOString(),
    durationMs: 0,
    steps: [],
    decisions: [],
    warnings: [],
    artifactsDir,
  };
  let sanitize = redactor({}, [process.env.JEV_API_KEY ?? ""]);
  let engine: DecisionEngine | undefined;
  const actions: ResolvedAction[] = [];
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.maxDurationMs ?? 300_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  // Closing the adapter interrupts Playwright operations on cancellation/deadline.
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= options.platform.close());
  const abort = () => {
    void close().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const variables = resolveVariables(spec.variables);
    sanitize = redactor(variables, [process.env.JEV_API_KEY ?? ""]);
    const policy = { ...defaultPolicy, ...options.policy };
    for (const [key, value] of Object.entries(policy))
      if (!Number.isFinite(value) || value < 0 || value > 1)
        throw new HarnessError(
          "INVALID_POLICY",
          `${key} must be between 0 and 1`,
        );
    if (!options.provider && !options.replay)
      throw new HarnessError(
        "MISSING_PROVIDER",
        "Live runs require a decision provider",
      );
    engine = options.provider
      ? new DecisionEngine(options.provider, policy, sanitize)
      : undefined;
    const steps =
      options.replay?.actions ?? (await engine!.compile(spec.steps, signal));
    if (
      options.requireAssertions !== false &&
      !steps.some((s) => s.operation.startsWith("assert_"))
    )
      throw new HarnessError(
        "NO_ASSERTIONS",
        "At least one explicit verification is required",
      );
    // Validate variables before touching the UI.
    for (const step of steps)
      if (step.value !== undefined) substitute(step.value, variables);
    signal.throwIfAborted();
    await options.platform.open(spec.baseUrl);
    signal.throwIfAborted();
    for (const [index, step] of steps.entries()) {
      const start = performance.now();
      const result: StepResult = {
        index,
        text: step.text,
        status: "blocked",
        durationMs: 0,
      };
      report.steps.push(result);
      try {
        signal.throwIfAborted();
        const action = options.replay
          ? (step as ResolvedAction)
          : await engine!.resolve(
              step,
              await options.platform.observe(),
              signal,
            );
        signal.throwIfAborted();
        result.action = action;
        await options.platform.execute({
          ...action,
          value:
            action.value === undefined
              ? undefined
              : substitute(action.value, variables),
        });
        signal.throwIfAborted();
        actions.push(action);
        result.status = "passed";
      } catch (error) {
        result.status = signal.aborted
          ? "blocked"
          : error instanceof HarnessError
            ? error.status
            : "failed";
        result.error = sanitize(
          signal.aborted
            ? "RUN_CANCELLED: Run cancelled or exceeded its time budget"
            : error instanceof Error
              ? error.message
              : String(error),
        );
      } finally {
        if (options.screenshots !== false && !signal.aborted) {
          const filename = `step-${String(index + 1).padStart(3, "0")}.png`;
          try {
            await options.platform.capture(join(artifactsDir, filename));
            result.screenshot = filename;
          } catch {
            report.warnings.push(
              `Screenshot unavailable for step ${index + 1}`,
            );
          }
        }
        if (signal.aborted) {
          result.status = "blocked";
          result.error =
            "RUN_CANCELLED: Run cancelled or exceeded its time budget";
        }
        result.durationMs = Math.round(performance.now() - start);
        options.onStep?.(JSON.parse(sanitize(JSON.stringify(result))));
      }
      if (result.status !== "passed") {
        report.status = result.status;
        break;
      }
    }
    if (
      report.steps.length === steps.length &&
      report.steps.every((s) => s.status === "passed")
    )
      report.status = "passed";
  } catch (error) {
    report.status = error instanceof HarnessError ? error.status : "blocked";
    report.error = sanitize(
      signal.aborted
        ? "RUN_CANCELLED: Run cancelled or exceeded its time budget"
        : error instanceof Error
          ? error.message
          : String(error),
    );
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      await close();
    } catch {
      report.warnings.push("Browser cleanup or trace persistence failed");
    }
    report.durationMs = Math.round(performance.now() - started);
    report.decisions = engine?.events ?? [];
    await saveArtifacts(report, spec, actions, sanitize);
  }
  return JSON.parse(sanitize(JSON.stringify(report))) as RunReport;
}
