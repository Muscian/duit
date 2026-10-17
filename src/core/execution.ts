import type { FieldWriter } from "./content.js";
import { DecisionEngine } from "./decisions.js";
import { substitute } from "./input.js";
import {
  HarnessError,
  pageOperations,
  type CompiledStep,
  type InterruptionRule,
  type Observation,
  type PlatformAdapter,
  type ResolvedAction,
  type RunReport,
  type StepResult,
  type VisualOptions,
  type VisualFrame,
} from "./types.js";

export const evidence = (
  o: Observation,
): NonNullable<StepResult["evidence"]> => ({
  url: o.url,
  title: o.title,
  text: o.text?.slice(0, 5000),
  dialogs: o.dialogs,
  controls: o.elements
    .filter((e) => e.visible && !e.occluded)
    .map((e) => `${e.role || e.tag}: ${e.name || e.text}`)
    .filter(Boolean)
    .slice(0, 80),
});
export function failureCategory(error: unknown): StepResult["category"] {
  const code = error instanceof HarnessError ? error.code : "";
  if (/ASSERTION/.test(code)) return "assertion";
  if (
    /JEV_|UNCERTAIN|INVALID_MODEL|MISSING_LITERAL|UNSUPPORTED_STEP/.test(code)
  )
    return "decision";
  if (/NETWORK|RESOURCES|CONNECTION|HTTP_|NAVIGATION_TIMEOUT/.test(code))
    return "environment";
  if (/VARIABLE|INVALID_|NO_ASSERTIONS|MISSING_PROVIDER/.test(code))
    return "configuration";
  return error instanceof HarnessError ? "ui" : "assertion";
}
async function pause(signal?: AbortSignal, delayMs = 250) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export class StepExecutor {
  private handled = new Map<string, number>();
  private activeRules = new Set<string>();
  private signal?: AbortSignal;
  private compiledRules = new Map<string, CompiledStep>();
  constructor(
    private options: {
      platform: PlatformAdapter;
      engine?: DecisionEngine;
      variables: Record<string, string>;
      interruptions?: InterruptionRule[];
      visual?: VisualOptions;
      writer?: FieldWriter;
      onVisualFrame?: (frame: VisualFrame) => Promise<string>;
      events: NonNullable<RunReport["interruptions"]>;
      readinessTimeoutMs?: number;
      onInterruptionAction?: (action: ResolvedAction) => void;
      beforeDispatch?: () => Promise<void>;
    },
  ) {
    if (options.interruptions?.length)
      options.platform.setInterruptionHandler?.(async () => {
        await this.interruptions(await this.inspect(this.signal), this.signal);
      });
  }
  private async inspect(signal?: AbortSignal): Promise<Observation> {
    signal?.throwIfAborted();
    const deadline = Date.now() + (this.options.readinessTimeoutMs ?? 15000);
    for (;;) {
      try {
        return await this.options.platform.observe();
      } catch (error) {
        if (
          Date.now() >= deadline ||
          !(error instanceof Error) ||
          !/Execution context was destroyed|Cannot find context|Frame was detached/.test(
            error.message,
          )
        )
          throw error;
        await pause(signal);
      }
    }
  }
  private contextMatches(step: CompiledStep, o: Observation) {
    const context = step.context;
    return (
      !context ||
      ((!context.urlIncludes ||
        o.url.includes(
          substitute(context.urlIncludes, this.options.variables),
        )) &&
        (!context.text ||
          (o.text ?? o.elements.map((e) => e.text).join(" ")).includes(
            substitute(context.text, this.options.variables),
          )))
    );
  }
  private matches(rule: InterruptionRule, o: Observation) {
    return (
      (!rule.when.urlIncludes || o.url.includes(rule.when.urlIncludes)) &&
      `${o.text ?? ""} ${o.elements
        .filter((e) => e.visible)
        .map((e) => e.name)
        .join(" ")}`.includes(rule.when.text)
    );
  }
  private async interruptions(
    observation: Observation,
    signal?: AbortSignal,
  ): Promise<Observation> {
    const { engine, platform, events } = this.options;
    let preparationRefreshes = 0;
    for (let total = 0; total < 20; total++) {
      const rule = this.options.interruptions?.find(
        (r) => !this.activeRules.has(r.name) && this.matches(r, observation),
      );
      if (!rule) return observation;
      this.activeRules.add(rule.name);
      try {
        if (!engine)
          throw new HarnessError(
            "INTERRUPTION_REQUIRES_PROVIDER",
            "Interactive interruption handling requires Jev; replay executes only its recorded actions",
          );
        if ((this.handled.get(rule.name) ?? 0) >= (rule.maxRuns ?? 1))
          throw new HarnessError(
            "INTERRUPTION_LIMIT",
            `Notice ${rule.name} returned after its configured limit`,
          );
        let step = this.compiledRules.get(rule.name);
        if (!step) {
          [step] = await engine.compile([rule.action], signal);
          this.compiledRules.set(rule.name, step);
        }
        if (
          step.operation !== "click" &&
          !(step.operation === "press" && step.value === "Escape")
        )
          throw new HarnessError(
            "INVALID_INTERRUPTION",
            "Notice handlers must click a control or press Escape",
          );
        let action: ResolvedAction;
        try {
          action = await engine.resolve(step, observation, signal);
          await platform.prepare?.(action);
        } catch (error) {
          if (
            error instanceof HarnessError &&
            ["UI_NOT_ACTIONABLE", "NO_TARGET", "UNCERTAIN_DECISION"].includes(
              error.code,
            ) &&
            preparationRefreshes++ < 2
          ) {
            const fresh = await this.inspect(signal);
            if (JSON.stringify(fresh) !== JSON.stringify(observation)) {
              observation = fresh;
              continue; // Nothing dispatched: re-evaluate the notice on the current page.
            }
          }
          throw error;
        }
        const event: NonNullable<RunReport["interruptions"]>[number] = {
          name: rule.name,
          action,
          url: observation.url,
          status: "blocked",
        };
        events.push(event);
        try {
          signal?.throwIfAborted();
          // Count dispatch, not success: a notice click is never repeated after an uncertain result.
          this.handled.set(rule.name, (this.handled.get(rule.name) ?? 0) + 1);
          await platform.execute(action);
          const deadline =
            Date.now() + (this.options.readinessTimeoutMs ?? 15000);
          do {
            observation = await this.inspect(signal);
            if (!this.matches(rule, observation)) break;
            await pause(signal);
          } while (Date.now() < deadline);
          if (this.matches(rule, observation))
            throw new HarnessError(
              "INTERRUPTION_UNRESOLVED",
              `Notice ${rule.name} is still visible after its action; inspect before continuing`,
            );
          event.status = "passed";
          this.options.onInterruptionAction?.(action);
        } catch (error) {
          event.error = error instanceof Error ? error.message : String(error);
          throw error;
        }
      } finally {
        this.activeRules.delete(rule.name);
      }
    }
    throw new HarnessError(
      "INTERRUPTION_LIMIT",
      "Too many notices during one step",
    );
  }
  async perform(
    step: CompiledStep,
    result: StepResult,
    signal?: AbortSignal,
    replay?: ResolvedAction,
  ): Promise<ResolvedAction> {
    if (step.wait) {
      if (!step.operation.startsWith("assert_"))
        throw new HarnessError("INVALID_WAIT", "Only assertions can be polled");
      if (
        (step.wait.refreshPage || step.wait.refreshControl) &&
        !this.options.platform.refresh
      )
        throw new HarnessError(
          "INVALID_WAIT",
          "This adapter cannot refresh its view",
        );
      const deadline = Date.now() + step.wait.timeoutMs;
      const waitSignal = AbortSignal.any([
        AbortSignal.timeout(step.wait.timeoutMs),
        ...(signal ? [signal] : []),
      ]);
      let lastError: unknown;
      for (;;) {
        result.pollAttempts = (result.pollAttempts ?? 0) + 1;
        try {
          const action = await this.perform(
            { ...step, wait: undefined },
            result,
            waitSignal,
            replay ? { ...replay, wait: undefined } : undefined,
          );
          result.action = { ...action, wait: step.wait };
          return result.action;
        } catch (error) {
          lastError = error;
          if (signal?.aborted) throw error;
          if (waitSignal.aborted || Date.now() >= deadline) break;
          if (
            error instanceof HarnessError &&
            !["NO_TARGET", "UNCERTAIN_DECISION", "CONTEXT_MISMATCH"].includes(
              error.code,
            )
          )
            throw error;
        }
        await pause(
          signal,
          Math.min(
            step.wait.intervalMs ?? 1000,
            Math.max(1, deadline - Date.now()),
          ),
        );
        if (Date.now() >= deadline) break;
        if (step.wait.refreshPage || step.wait.refreshControl)
          await this.options.platform.refresh!(step.wait.refreshControl);
      }
      throw new HarnessError(
        "ASSERTION_WAIT_TIMEOUT",
        `Assertion did not reach its expected state within ${step.wait.timeoutMs}ms (${result.pollAttempts} observations). ${lastError instanceof Error ? lastError.message : ""}`,
        "failed",
      );
    }
    this.signal = signal;
    const { platform, engine, variables } = this.options;
    if (step.scope && pageOperations.has(step.operation))
      throw new HarnessError(
        "INVALID_SCOPE",
        "scope selects a target control; use context for page-wide assertions/navigation",
      );
    for (const text of [
      step.generate?.prompt,
      step.control?.name,
      step.text,
      step.literalValue ? undefined : step.value,
      step.scope,
      step.context?.text,
      step.context?.urlIncludes,
      ...(step.aliases ?? []),
    ])
      if (text !== undefined) substitute(text, variables);
    const visualEnabled =
      step.operation === "click" &&
      step.visual !== "off" &&
      this.options.visual?.enabled;
    const visualResolve = async () => {
      if (!platform.observeVisual || !engine)
        throw new HarnessError(
          "VISUAL_UNAVAILABLE",
          "Adapter/provider cannot observe and resolve a visual target",
        );
      const frame = await platform.observeVisual();
      result.visualScreenshot = await this.options.onVisualFrame?.(frame);
      return engine.resolveVisual(
        {
          ...step,
          text: substitute(step.text, variables),
          scope: step.scope ? substitute(step.scope, variables) : undefined,
        },
        frame,
        this.options.visual!,
        signal,
      );
    };
    if (step.visual === "only" && !visualEnabled)
      throw new HarnessError(
        "VISUAL_UNAVAILABLE",
        "Enable case.visual.enabled for visual-only clicks",
      );
    let deadline = Date.now() + (this.options.readinessTimeoutMs ?? 15000);
    let action: ResolvedAction | undefined;
    let lastError: unknown;
    let fingerprint = "";
    let resolutions = 0;
    // Re-observe and re-resolve only before dispatch. Never retry an action here.
    do {
      signal?.throwIfAborted();
      let observation: Observation | undefined;
      if (
        !pageOperations.has(step.operation) ||
        step.context ||
        this.options.interruptions?.length
      ) {
        result.phase = "context";
        observation = await this.interruptions(
          await this.inspect(signal),
          signal,
        );
        result.evidence = evidence(observation);
        if (!this.contextMatches(step, observation)) {
          lastError = new HarnessError(
            "CONTEXT_MISMATCH",
            `Expected context ${JSON.stringify(step.context)}; current page is ${observation.url} (${observation.title}). Inspect the active tab or navigate to the required application.`,
          );
          await pause(signal);
          continue;
        }
      }
      result.phase = "resolve";
      const nextFingerprint = JSON.stringify(observation);
      if (
        !replay &&
        !pageOperations.has(step.operation) &&
        nextFingerprint === fingerprint
      ) {
        await pause(signal);
        continue;
      }
      fingerprint = nextFingerprint;
      try {
        const resolved =
          (step.visual === "only" ? await visualResolve() : replay) ??
          (await engine!.resolve(
            {
              ...step,
              text: substitute(step.text, variables),
              control: step.control
                ? {
                    ...step.control,
                    name: substitute(step.control.name, variables),
                  }
                : undefined,
              scope: step.scope ? substitute(step.scope, variables) : undefined,
              aliases: step.aliases?.map((s) => substitute(s, variables)),
            },
            observation,
            signal,
          ));
        action = { ...resolved, text: step.text };
        break;
      } catch (error) {
        lastError = error;
        if (
          visualEnabled &&
          error instanceof HarnessError &&
          ["NO_TARGET", "UNCERTAIN_DECISION", "TOO_MANY_ELEMENTS"].includes(
            error.code,
          )
        ) {
          action = await visualResolve();
          break;
        }
        if (
          !(error instanceof HarnessError) ||
          !["NO_TARGET", "UNCERTAIN_DECISION"].includes(error.code) ||
          ++resolutions >= 4
        )
          throw error;
        if (resolutions === 1 && Date.now() >= deadline)
          deadline = Date.now() + 2000;
      }
      await pause(signal);
    } while (Date.now() < deadline);
    if (!action)
      throw (
        lastError ??
        new HarnessError(
          "NO_TARGET",
          "No matching control appeared before the readiness deadline",
        )
      );
    let resolved = {
      ...action,
      value:
        action.value === undefined
          ? undefined
          : action.literalValue
            ? action.value
            : substitute(action.value, variables),
    };
    for (let attempt = 0; ; attempt++) {
      result.action = action;
      result.phase = "prepare";
      try {
        await platform.prepare?.(resolved);
        break;
      } catch (error) {
        if (
          replay ||
          !engine ||
          attempt >= 2 ||
          !(error instanceof HarnessError) ||
          error.code !== "UI_NOT_ACTIONABLE"
        )
          throw error;
        const before = this.options.events.length;
        const observation = await this.interruptions(
          await this.inspect(signal),
          signal,
        );
        result.evidence = evidence(observation);
        if (!this.contextMatches(step, observation))
          throw new HarnessError(
            "CONTEXT_MISMATCH",
            `Page changed before dispatch: ${observation.url}. Inspect before continuing.`,
          );
        const currentFingerprint = JSON.stringify(observation);
        if (
          this.options.events.length === before &&
          currentFingerprint === fingerprint
        )
          throw error;
        fingerprint = currentFingerprint;
        result.phase = "resolve";
        action = {
          ...(await engine.resolve(
            {
              ...step,
              text: substitute(step.text, variables),
              control: step.control
                ? {
                    ...step.control,
                    name: substitute(step.control.name, variables),
                  }
                : undefined,
              scope: step.scope ? substitute(step.scope, variables) : undefined,
              aliases: step.aliases?.map((s) => substitute(s, variables)),
            },
            observation,
            signal,
          )),
          text: step.text,
        };
        resolved = {
          ...action,
          value:
            action.value === undefined
              ? undefined
              : action.literalValue
                ? action.value
                : substitute(action.value, variables),
        };
      }
    }
    signal?.throwIfAborted();
    if (step.generate) {
      if (step.operation !== "fill" || !this.options.writer)
        throw new HarnessError(
          "CONTENT_PROVIDER_REQUIRED",
          "Generated fills require an explicitly configured writer",
        );
      const generated = await this.options.writer.write(
        {
          ...step.generate,
          prompt: substitute(step.generate.prompt, variables),
        },
        signal,
      );
      action = {
        ...action,
        generate: undefined,
        value: generated.text,
        literalValue: true,
      };
      resolved = {
        ...resolved,
        generate: undefined,
        value: generated.text,
        literalValue: true,
      };
      result.action = action;
    }
    result.phase = action.operation.startsWith("assert_")
      ? "assert"
      : "dispatch";
    if (result.phase === "dispatch") {
      try {
        await this.options.beforeDispatch?.();
      } catch {
        result.phase = "prepare";
        throw new HarnessError(
          "CHECKPOINT_WRITE_FAILED",
          "Could not persist the action checkpoint; no action was dispatched",
        );
      }
    }
    signal?.throwIfAborted();
    try {
      await platform.execute(resolved);
    } catch (error) {
      if (result.phase === "dispatch")
        throw new HarnessError(
          "ACTION_OUTCOME_UNKNOWN",
          `The ${action.operation} action was dispatched but did not complete reliably. Inspect the current UI before continuing; do not repeat it automatically. ${error instanceof Error ? error.message : String(error)}`,
        );
      throw error;
    }
    signal?.throwIfAborted();
    result.phase = "complete";
    return action;
  }
}
