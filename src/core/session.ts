import {
  resolvePrivacy,
  privateProvider,
  privateReport,
  privateStep,
  privacyDenied,
} from "./privacy.js";
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
  private rawReport: RunReport;
  get report(): RunReport {
    return JSON.parse(
      this.sanitize(JSON.stringify(privateReport(this.rawReport))),
    );
  }
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
  private inspections = 0;
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
    const privacy = resolvePrivacy(this.spec.privacy);
    options.platform.configurePrivacy?.(privacy);
    if (!privacy.images) options.screenshots = false;
    const variables = resolveVariables(this.spec.variables);
    this.sanitize = redactor(
      Object.fromEntries(
        Object.entries(variables).filter(
          ([name]) => !this.spec.publicVariables?.includes(name),
        ),
      ),
      [
        process.env.JEV_API_KEY ?? "",
        process.env.DUIT_WRITER_API_KEY ?? "",
        ...(this.spec.privacy?.redact ?? []),
      ],
      !privacy.detailedArtifacts,
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
    this.engine = new DecisionEngine(
      privateProvider(this.metered, privacy),
      policy,
      this.sanitize,
      privacy,
      this.spec.decisionContext,
    );
    this.rawReport = {
      privacy,
      lifecycle: "open",
      cleanupExpected: this.spec.cleanup?.length ?? 0,
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
      privacy.writer,
    );
    this.executor = new StepExecutor({
      privacy,
      platform: options.platform,
      engine: this.engine,
      variables,
      interruptions: this.spec.interruptions,
      interaction: this.spec.interaction,
      visual: this.spec.visual,
      writer: this.writer,
      onVisualFrame:
        options.screenshots === false
          ? undefined
          : async (frame) => {
              const name = `visual-${frame.revision.slice(0, 12)}.png`;
              await writeFile(
                join(this.rawReport.artifactsDir, name),
                Buffer.from(frame.dataBase64, "base64"),
                { mode: 0o600 },
              );
              return name;
            },
      events: this.rawReport.interruptions!,
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
    await mkdir(dirname(this.rawReport.artifactsDir), { recursive: true });
    await mkdir(this.rawReport.artifactsDir, { recursive: false, mode: 0o700 });
    try {
      this.signal.throwIfAborted();
      await this.options.platform.open(this.spec.baseUrl);
      await this.persist();
    } catch (error) {
      this.rawReport.error = this.sanitize(
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
    let observation = await this.options.platform.observe();
    if (!this.rawReport.privacy?.detailedArtifacts) {
      observation = {
        ...observation,
        text: undefined,
        title: "[omitted]",
        dialogs: undefined,
        elements: observation.elements.map((e) => ({
          ...e,
          text: "",
          context: "",
          href: undefined,
        })),
      };
    }
    const safe = JSON.parse(
      this.sanitize(JSON.stringify(observation)),
    ) as Observation;
    // Inspection is itself evidence and must survive session closure.
    await writeFile(
      join(
        this.rawReport.artifactsDir,
        `inspection-${String(++this.inspections).padStart(3, "0")}.json`,
      ),
      JSON.stringify(safe, null, 2),
      { mode: 0o600 },
    );
    return safe;
  }
  async capture() {
    this.active();
    if (!this.rawReport.privacy?.images) privacyDenied("screenshots");
    await this.options.platform.capture(
      join(this.rawReport.artifactsDir, "current.png"),
    );
    return join(this.rawReport.artifactsDir, "current.png");
  }
  private unresolved() {
    return [...this.rawReport.steps]
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
      index: this.rawReport.steps.length,
      text: typeof input === "string" ? input : input.instruction,
      status: "blocked",
      durationMs: 0,
      phase: "compile",
    };
    this.rawReport.steps.push(result);
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
            join(this.rawReport.artifactsDir, filename),
          );
          result.screenshot = filename;
        } catch {
          this.rawReport.warnings.push(
            `Screenshot unavailable for step ${result.index + 1}`,
          );
        }
      }
      result.durationMs = Math.round(performance.now() - start);
      this.busy = false;
      await this.persist();
    }
    return JSON.parse(
      this.sanitize(
        JSON.stringify(privateStep(result, this.rawReport.privacy)),
      ),
    ) as StepResult;
  }
  private hasUncertainAncestor(step: StepResult): boolean {
    for (
      let current: StepResult | undefined = step;
      current;
      current =
        current.retryOf === undefined
          ? undefined
          : this.rawReport.steps[current.retryOf]
    )
      if (
        current.phase === "dispatch" ||
        current.error?.startsWith("ACTION_OUTCOME_UNKNOWN:")
      )
        return true;
    return false;
  }
  async retry(replacement?: StepInstruction) {
    const previous = this.unresolved();
    if (!previous)
      throw new HarnessError(
        "NOTHING_TO_RETRY",
        "There is no unresolved failed step",
      );
    if (
      previous.phase === "dispatch" ||
      previous.error?.startsWith("ACTION_OUTCOME_UNKNOWN:")
    )
      throw new HarnessError(
        "ACTION_OUTCOME_UNKNOWN",
        "The last action may already have happened. Inspect, then use :confirm with an assertion. Retrying a mutation is prohibited.",
      );
    const result = await this.step(
      replacement ?? this.inputs[previous.index],
      this.hasUncertainAncestor(previous),
    );
    this.rawReport.steps[result.index].retryOf = previous.index;
    if (result.status === "passed") {
      let ancestor: StepResult | undefined = previous;
      while (ancestor) {
        ancestor.recoveredBy = result.index;
        ancestor =
          ancestor.retryOf === undefined
            ? undefined
            : this.rawReport.steps[ancestor.retryOf];
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
    this.rawReport.steps[result.index].retryOf = previous.index;
    if (result.status === "passed") {
      let ancestor: StepResult | undefined = previous;
      while (ancestor) {
        ancestor.recoveredBy = result.index;
        ancestor =
          ancestor.retryOf === undefined
            ? undefined
            : this.rawReport.steps[ancestor.retryOf];
      }
    }
    await this.persist();
    return result;
  }
  private async persist() {
    this.rawReport.lifecycle = this.closed ? "closed" : "open";
    this.rawReport.durationMs = Math.round(performance.now() - this.started);
    this.rawReport.decisions = this.engine.events;
    this.rawReport.visualDecisions = this.engine.visualEvents;
    this.rawReport.contentUsage = { ...this.writer.usage };
    this.rawReport.usage = { ...this.metered.usage };
    this.rawReport.diagnostics = this.options.platform.diagnostics?.();
    await saveArtifacts(this.rawReport, this.spec, [], this.sanitize);
    await saveCheckpoint(
      this.rawReport,
      this.sanitize,
      this.closed ? "closed" : "open",
    );
  }
  async close(runCleanup = true): Promise<RunReport> {
    if (this.closed)
      return JSON.parse(
        this.sanitize(JSON.stringify(privateReport(this.rawReport))),
      ) as RunReport;
    if (runCleanup && !this.signal.aborted && this.spec.cleanup?.length) {
      this.rawReport.cleanup = [];
      for (const input of this.spec.cleanup) {
        const result = await this.step(input);
        this.rawReport.cleanup.push(this.rawReport.steps[result.index]);
        if (result.status !== "passed") break;
      }
    }
    if (runCleanup && this.signal.aborted && this.spec.cleanup?.length)
      this.rawReport.warnings.push(
        "Cleanup was not executed because the browser was cancelled. Inspect the current resource state before rerunning.",
      );
    this.closed = true;
    this.rawReport.status =
      this.rawReport.error ||
      this.signal.aborted ||
      this.unresolved() ||
      !this.rawReport.steps.some(
        (s) =>
          s.status === "passed" && s.action?.operation.startsWith("assert_"),
      )
        ? "blocked"
        : "passed";
    if (
      !this.rawReport.steps.some(
        (s) =>
          s.status === "passed" && s.action?.operation.startsWith("assert_"),
      )
    )
      this.rawReport.warnings.push(
        "No successful assertion was recorded; this exploration is not a passing test",
      );
    this.signal.removeEventListener("abort", this.abort);
    try {
      await this.options.platform.close();
    } catch {
      this.rawReport.warnings.push("Browser cleanup failed");
    }
    await this.persist();
    return JSON.parse(
      this.sanitize(JSON.stringify(privateReport(this.rawReport))),
    ) as RunReport;
  }
}
