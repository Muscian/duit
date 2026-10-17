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
import { StepExecutor, failureCategory, evidence } from "./execution.js";
import { saveArtifacts, saveCheckpoint, type ReplayPlan } from "./artifacts.js";
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
  readinessTimeoutMs?: number;
  screenshots?: boolean;
  onStep?: (step: StepResult) => void;
  onCleanupStep?: (step: StepResult) => void;
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
  let executor: StepExecutor | undefined;
  let cleanupSteps: import("./types.js").CompiledStep[] = [];
  let opened = false;
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
    sanitize = redactor(
      Object.fromEntries(
        Object.entries(variables).filter(
          ([name]) => !spec.publicVariables?.includes(name),
        ),
      ),
      [process.env.JEV_API_KEY ?? ""],
    );
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
    if (options.replay && spec.cleanup?.length)
      throw new HarnessError(
        "INVALID_REPLAY",
        "Replay already contains recorded cleanup actions; do not also supply live cleanup steps",
      );
    cleanupSteps = spec.cleanup?.length
      ? await engine!.compile(spec.cleanup, signal)
      : [];
    report.interruptions = [];
    executor = new StepExecutor({
      platform: options.platform,
      engine,
      variables,
      interruptions: options.replay ? undefined : spec.interruptions,
      events: report.interruptions,
      readinessTimeoutMs: options.readinessTimeoutMs,
      onInterruptionAction: (action) => actions.push(action),
      beforeDispatch: async () => {
        report.diagnostics = options.platform.diagnostics?.();
        await saveCheckpoint(report, sanitize);
      },
    });
    if (
      options.requireAssertions !== false &&
      !steps.some((s) => s.operation.startsWith("assert_"))
    )
      throw new HarnessError(
        "NO_ASSERTIONS",
        "At least one explicit verification is required",
      );
    // Validate variables before touching the UI.
    for (const step of [...steps, ...cleanupSteps]) {
      for (const text of [
        step.text,
        step.value,
        step.scope,
        step.context?.text,
        step.context?.urlIncludes,
        ...(step.aliases ?? []),
      ])
        if (text !== undefined) substitute(text, variables);
    }
    signal.throwIfAborted();
    await options.platform.open(spec.baseUrl);
    opened = true;
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
        const action = await executor.perform(
          step,
          result,
          signal,
          options.replay ? (step as ResolvedAction) : undefined,
        );
        actions.push(action);
        result.status = "passed";
      } catch (error) {
        result.status = signal.aborted
          ? "blocked"
          : error instanceof HarnessError
            ? error.status
            : "failed";
        result.category = failureCategory(error);
        if (!signal.aborted)
          try {
            result.evidence = evidence(await options.platform.observe());
          } catch {}
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
    if (opened && executor && cleanupSteps.length && !signal.aborted) {
      report.cleanup = [];
      for (const [index, step] of cleanupSteps.entries()) {
        const result: StepResult = {
          index,
          text: step.text,
          status: "blocked",
          durationMs: 0,
        };
        report.cleanup.push(result);
        const start = performance.now();
        try {
          const action = await executor.perform(step, result, signal);
          actions.push(action);
          result.status = "passed";
        } catch (error) {
          result.status =
            error instanceof HarnessError ? error.status : "failed";
          result.category = failureCategory(error);
          result.error = sanitize(
            error instanceof Error ? error.message : String(error),
          );
          if (report.status === "passed") report.status = "blocked";
        }
        result.durationMs = Math.round(performance.now() - start);
        if (options.screenshots !== false) {
          const filename = `cleanup-${index + 1}.png`;
          try {
            await options.platform.capture(join(artifactsDir, filename));
            result.screenshot = filename;
          } catch {
            report.warnings.push("Cleanup screenshot unavailable");
          }
        }
        options.onCleanupStep?.(JSON.parse(sanitize(JSON.stringify(result))));
        if (result.status !== "passed") break;
      }
    } else if (opened && cleanupSteps.length && signal.aborted) {
      report.warnings.push(
        "Cleanup was not executed because the browser was cancelled. Inspect the current resource state before rerunning.",
      );
    }
    if (report.error && !signal.aborted && options.screenshots !== false) {
      try {
        await options.platform.capture(join(artifactsDir, "startup.png"));
        report.screenshot = "startup.png";
      } catch {
        report.warnings.push("Startup screenshot unavailable");
      }
    }
    report.diagnostics = options.platform.diagnostics?.();
    signal.removeEventListener("abort", abort);
    try {
      await close();
    } catch {
      report.warnings.push("Browser cleanup or trace persistence failed");
    }
    report.durationMs = Math.round(performance.now() - started);
    report.decisions = engine?.events ?? [];
    await saveArtifacts(report, spec, actions, sanitize);
    await saveCheckpoint(report, sanitize, "closed");
  }
  return JSON.parse(sanitize(JSON.stringify(report))) as RunReport;
}
