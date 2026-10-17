import { FieldWriter, type ContentProvider } from "./content.js";
import { MeteredProvider } from "./metering.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DecisionEngine,
  defaultPolicy,
  type DecisionPolicy,
} from "./decisions.js";
import { StepExecutor, evidence, failureCategory } from "./execution.js";
import { caseSchema, redactor, resolveVariables, stepSchema } from "./input.js";
import { saveArtifacts, saveCheckpoint } from "./artifacts.js";
import {
  HarnessError,
  type CaseSpec,
  type DecisionProvider,
  type Observation,
  type PlatformAdapter,
  type RunReport,
  type StepInstruction,
  type StepResult,
} from "./types.js";

/** A bounded live session. Failures retain the same page; mutations are never auto-retried. */
export class HarnessSession {
  readonly report: RunReport;
  private engine: DecisionEngine;
  private metered: MeteredProvider;
  private writer: FieldWriter;
  private executor: StepExecutor;
  private sanitize: (s: string) => string;
  private spec: CaseSpec;
  private inputs: StepInstruction[] = [];
  private started = performance.now();
  private closed = false;
  private busy = false;
  private signal: AbortSignal;
  private abort = () => {
    void this.options.platform.close().catch(() => {});
  };
  constructor(
    input: CaseSpec,
    private options: {
      provider: DecisionProvider;
      contentProvider?: ContentProvider;
      platform: PlatformAdapter;
      artifactsDir?: string;
      policy?: Partial<DecisionPolicy>;
      readinessTimeoutMs?: number;
      maxDurationMs?: number;
      signal?: AbortSignal;
      screenshots?: boolean;
    },
  ) {
    this.spec = caseSchema.parse(input);
    const variables = resolveVariables(this.spec.variables);
    this.sanitize = redactor(
      Object.fromEntries(
        Object.entries(variables).filter(
          ([name]) => !this.spec.publicVariables?.includes(name),
        ),
      ),
      [process.env.JEV_API_KEY ?? "", process.env.DUIT_WRITER_API_KEY ?? ""],
    );
    const policy = { ...defaultPolicy, ...options.policy };
    if (
      Object.values(policy).some((v) => !Number.isFinite(v) || v < 0 || v > 1)
    )
      throw new HarnessError(
        "INVALID_POLICY",
        "Decision thresholds must be between 0 and 1",
      );
    this.metered = new MeteredProvider(options.provider, this.spec.costs);
    this.engine = new DecisionEngine(this.metered, policy, this.sanitize);
    this.report = {
      version: 1,
      name: this.spec.name,
      mode: "interactive",
      status: "blocked",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      steps: [],
      decisions: [],
      interruptions: [],
      warnings: [],
      artifactsDir: resolve(
        options.artifactsDir ??
          join(
            "artifacts",
            `session-${Date.now()}-${randomUUID().slice(0, 8)}`,
          ),
      ),
    };
    this.writer = new FieldWriter(
      options.contentProvider,
      this.spec.content,
      this.sanitize,
    );
    this.executor = new StepExecutor({
      platform: options.platform,
      engine: this.engine,
      variables,
      interruptions: this.spec.interruptions,
      visual: this.spec.visual,
      writer: this.writer,
      onVisualFrame:
        options.screenshots === false
          ? undefined
          : async (frame) => {
              const name = `visual-${frame.revision.slice(0, 12)}.png`;
              await writeFile(
                join(this.report.artifactsDir, name),
                Buffer.from(frame.dataBase64, "base64"),
              );
              return name;
            },
      events: this.report.interruptions!,
      readinessTimeoutMs: options.readinessTimeoutMs,
      beforeDispatch: () => this.persist(),
    });
    this.signal = AbortSignal.any([
      AbortSignal.timeout(options.maxDurationMs ?? 1800000),
      ...(options.signal ? [options.signal] : []),
    ]);
    this.signal.addEventListener("abort", this.abort, { once: true });
  }
  async open() {
    await mkdir(dirname(this.report.artifactsDir), { recursive: true });
    await mkdir(this.report.artifactsDir, { recursive: false });
    try {
      this.signal.throwIfAborted();
      await this.options.platform.open(this.spec.baseUrl);
      await this.persist();
    } catch (error) {
      this.report.error = this.sanitize(
        error instanceof Error ? error.message : String(error),
      );
      await this.persist();
      await this.close(false);
      throw error;
    }
  }
  private active() {
    if (this.closed)
      throw new HarnessError("SESSION_CLOSED", "The session is closed");
    this.signal.throwIfAborted();
  }
  async inspect(): Promise<Observation> {
    this.active();
    return JSON.parse(
      this.sanitize(JSON.stringify(await this.options.platform.observe())),
    ) as Observation;
  }
  async capture() {
    this.active();
    await this.options.platform.capture(
      join(this.report.artifactsDir, "current.png"),
    );
    return join(this.report.artifactsDir, "current.png");
  }
  private unresolved() {
    return [...this.report.steps]
      .reverse()
      .find((s) => s.status !== "passed" && s.recoveredBy === undefined);
  }
  async step(
    input: StepInstruction,
    assertionOnly = false,
  ): Promise<StepResult> {
    this.active();
    if (this.busy)
      throw new HarnessError(
        "SESSION_BUSY",
        "Wait for the active step before sending another",
      );
    this.busy = true;
    const start = performance.now();
    const result: StepResult = {
      index: this.report.steps.length,
      text: typeof input === "string" ? input : input.instruction,
      status: "blocked",
      durationMs: 0,
      phase: "compile",
    };
    this.report.steps.push(result);
    this.inputs.push(input);
    try {
      const [step] = await this.engine.compile(
        [stepSchema.parse(input)],
        this.signal,
      );
      if (assertionOnly && !step.operation.startsWith("assert_"))
        throw new HarnessError(
          "CONFIRM_REQUIRES_ASSERTION",
          "Confirm an uncertain action with an observable assertion; no action was dispatched",
        );
      await this.executor.perform(step, result, this.signal);
      result.status = "passed";
    } catch (error) {
      result.status = this.signal.aborted
        ? "blocked"
        : error instanceof HarnessError
          ? error.status
          : "failed";
      result.category = failureCategory(error);
      result.error = this.sanitize(
        this.signal.aborted
          ? "RUN_CANCELLED: Session exceeded its budget or was cancelled"
          : error instanceof Error
            ? error.message
            : String(error),
      );
      if (!this.signal.aborted)
        try {
          result.evidence = evidence(await this.options.platform.observe());
        } catch {}
    } finally {
      if (!this.signal.aborted && this.options.screenshots !== false) {
        const filename = `step-${String(result.index + 1).padStart(3, "0")}.png`;
        try {
          await this.options.platform.capture(
            join(this.report.artifactsDir, filename),
          );
          result.screenshot = filename;
        } catch {
          this.report.warnings.push(
            `Screenshot unavailable for step ${result.index + 1}`,
          );
        }
      }
      result.durationMs = Math.round(performance.now() - start);
      this.busy = false;
      await this.persist();
    }
    return JSON.parse(this.sanitize(JSON.stringify(result))) as StepResult;
  }
  private hasUncertainAncestor(step: StepResult): boolean {
    for (
      let current: StepResult | undefined = step;
      current;
      current =
        current.retryOf === undefined
          ? undefined
          : this.report.steps[current.retryOf]
    )
      if (current.phase === "dispatch") return true;
    return false;
  }
  async retry(replacement?: StepInstruction) {
    const previous = this.unresolved();
    if (!previous)
      throw new HarnessError(
        "NOTHING_TO_RETRY",
        "There is no unresolved failed step",
      );
    if (previous.phase === "dispatch")
      throw new HarnessError(
        "ACTION_OUTCOME_UNKNOWN",
        "The last action may already have happened. Inspect, then use :confirm with an assertion. Retrying a mutation is prohibited.",
      );
    const result = await this.step(
      replacement ?? this.inputs[previous.index],
      this.hasUncertainAncestor(previous),
    );
    this.report.steps[result.index].retryOf = previous.index;
    if (result.status === "passed") {
      let ancestor: StepResult | undefined = previous;
      while (ancestor) {
        ancestor.recoveredBy = result.index;
        ancestor =
          ancestor.retryOf === undefined
            ? undefined
            : this.report.steps[ancestor.retryOf];
      }
    }
    await this.persist();
    return result;
  }
  async confirm(instruction: StepInstruction) {
    const previous = this.unresolved();
    if (!previous || !this.hasUncertainAncestor(previous))
      throw new HarnessError(
        "NOTHING_TO_CONFIRM",
        "Confirm is only for an action with an uncertain dispatched outcome",
      );
    const result = await this.step(instruction, true);
    this.report.steps[result.index].retryOf = previous.index;
    if (result.status === "passed") {
      let ancestor: StepResult | undefined = previous;
      while (ancestor) {
        ancestor.recoveredBy = result.index;
        ancestor =
          ancestor.retryOf === undefined
            ? undefined
            : this.report.steps[ancestor.retryOf];
      }
    }
    await this.persist();
    return result;
  }
  private async persist() {
    this.report.durationMs = Math.round(performance.now() - this.started);
    this.report.decisions = this.engine.events;
    this.report.visualDecisions = this.engine.visualEvents;
    this.report.contentUsage = { ...this.writer.usage };
    this.report.usage = { ...this.metered.usage };
    this.report.diagnostics = this.options.platform.diagnostics?.();
    await saveArtifacts(this.report, this.spec, [], this.sanitize);
    await saveCheckpoint(
      this.report,
      this.sanitize,
      this.closed ? "closed" : "open",
    );
  }
  async close(runCleanup = true): Promise<RunReport> {
    if (this.closed)
      return JSON.parse(
        this.sanitize(JSON.stringify(this.report)),
      ) as RunReport;
    if (runCleanup && !this.signal.aborted && this.spec.cleanup?.length) {
      this.report.cleanup = [];
      for (const input of this.spec.cleanup) {
        const result = await this.step(input);
        this.report.cleanup.push(result);
        if (result.status !== "passed") break;
      }
    }
    if (runCleanup && this.signal.aborted && this.spec.cleanup?.length)
      this.report.warnings.push(
        "Cleanup was not executed because the browser was cancelled. Inspect the current resource state before rerunning.",
      );
    this.closed = true;
    this.report.status =
      this.report.error ||
      this.signal.aborted ||
      this.unresolved() ||
      !this.report.steps.some(
        (s) =>
          s.status === "passed" && s.action?.operation.startsWith("assert_"),
      )
        ? "blocked"
        : "passed";
    if (
      !this.report.steps.some(
        (s) =>
          s.status === "passed" && s.action?.operation.startsWith("assert_"),
      )
    )
      this.report.warnings.push(
        "No successful assertion was recorded; this exploration is not a passing test",
      );
    this.signal.removeEventListener("abort", this.abort);
    try {
      await this.options.platform.close();
    } catch {
      this.report.warnings.push("Browser cleanup failed");
    }
    await this.persist();
    return JSON.parse(this.sanitize(JSON.stringify(this.report))) as RunReport;
  }
}
