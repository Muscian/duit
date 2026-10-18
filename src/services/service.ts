import { readFile, stat } from "node:fs/promises";
import type { ContentProvider } from "../core/content.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { caseSchema } from "../core/input.js";
import { runCase } from "../core/runner.js";
import { HarnessSession } from "../core/session.js";
import {
  HarnessError,
  type CaseSpec,
  type DecisionProvider,
  type PlatformAdapter,
  type RunReport,
  type StepInstruction,
} from "../core/types.js";

export class PlatformRegistry {
  private factories = new Map<string, (spec: CaseSpec) => PlatformAdapter>();
  register(name: string, factory: (spec: CaseSpec) => PlatformAdapter) {
    if (this.factories.has(name))
      throw new Error(`Platform already registered: ${name}`);
    this.factories.set(name, factory);
    return this;
  }
  names() {
    return [...this.factories.keys()];
  }
  create(spec: CaseSpec) {
    const name = spec.platform ?? "browser",
      factory = this.factories.get(name);
    if (!factory)
      throw new HarnessError(
        "UNSUPPORTED_PLATFORM",
        `Unknown platform ${name}; available: ${this.names().join(", ")}`,
      );
    return factory(spec);
  }
}
export const summarize = (report: RunReport) => ({
  privacy: report.privacy,
  agent: report.agent,
  name: report.name,
  status: report.status,
  durationMs: report.durationMs,
  usage: report.usage,
  contentUsage: report.contentUsage,
  steps: report.steps.map(({ index, text, status, error, phase, failure }) => ({
    index,
    text,
    status,
    error,
    phase,
    failure,
  })),
  cleanup: report.cleanup?.map(({ index, text, status, error }) => ({
    index,
    text,
    status,
    error,
  })),
  warnings: report.warnings,
  error: report.error,
});
type RunEntry = {
  state: "running" | "complete" | "error";
  controller: AbortController;
  report?: RunReport;
  progress?: { index: number; text: string; status: string };
  error?: string;
  done: Promise<void>;
};
type SessionEntry = {
  session: HarnessSession;
  provider: DecisionProvider;
  writer?: ContentProvider;
  touched: number;
  busy: boolean;
  operation?: Promise<unknown>;
  controller: AbortController;
};

/** Shared application boundary; transports and future platforms share this lifecycle. Trusted local clients only. */
export class DuitService {
  private runs = new Map<string, RunEntry>();
  private sessions = new Map<string, SessionEntry>();
  private pending = 0;
  private openings = new Map<AbortController, Promise<void>>();
  private timer: ReturnType<typeof setInterval>;
  private closing = false;
  constructor(
    private options: {
      platforms: PlatformRegistry;
      provider: () => DecisionProvider;
      contentProvider?: () => ContentProvider;
      artifactsRoot?: string;
      maxActive?: number;
      sessionIdleMs?: number;
      maxDurationMs?: number;
    },
  ) {
    this.timer = setInterval(() => {
      for (const [id, e] of this.sessions)
        if (
          !e.busy &&
          Date.now() - e.touched > (options.sessionIdleMs ?? 600000)
        )
          void this.closeSession(id).catch(() => {});
    }, 10000);
    this.timer.unref();
  }
  capabilities() {
    return {
      platforms: this.options.platforms.names(),
      maxActive: this.options.maxActive ?? 4,
      visual: "optional adapter/provider capability",
      model: "Jev by default; authoring content supplied by client",
    };
  }
  private reserve() {
    if (
      this.closing ||
      this.pending +
        this.sessions.size +
        [...this.runs.values()].filter((r) => r.state === "running").length >=
        (this.options.maxActive ?? 4)
    )
      throw new HarnessError(
        "SERVICE_CAPACITY",
        "Active run/session limit reached",
      );
  }
  private out(id: string) {
    return resolve(this.options.artifactsRoot ?? "artifacts/service", id);
  }
  startRun(input: unknown) {
    this.reserve();
    const spec = caseSchema.parse(input),
      id = randomUUID(),
      controller = new AbortController();
    const platform = this.options.platforms.create(spec),
      provider = this.options.provider(),
      writer = spec.content?.enabled
        ? this.options.contentProvider?.()
        : undefined;
    const entry: RunEntry = {
      state: "running",
      controller,
      done: Promise.resolve(),
    };
    this.runs.set(id, entry);
    entry.done = (async () => {
      try {
        entry.report = await runCase(spec, {
          provider,
          contentProvider: writer,
          platform,
          artifactsDir: this.out(id),
          maxDurationMs: this.options.maxDurationMs ?? 300000,
          signal: controller.signal,
          onStep: ({ index, text, status }) => {
            entry.progress = { index, text, status };
          },
        });
        entry.state = "complete";
      } catch {
        entry.error =
          "Run could not be started or persisted; inspect server configuration";
        entry.state = "error";
      } finally {
        await writer?.close?.();
        await provider.close?.();
        await platform.close().catch(() => {});
      }
    })().catch(() => {
      entry.state = "error";
      entry.error = "Run resource cleanup failed";
    });
    // Bound completed metadata retention, never evict an active run.
    for (const [key, value] of this.runs)
      if (this.runs.size > 100 && value.state !== "running")
        this.runs.delete(key);
    return { id, state: entry.state };
  }
  getRun(id: string, details = false) {
    const e = this.runs.get(id);
    if (!e) throw new HarnessError("NOT_FOUND", "Unknown run");
    return {
      id,
      state: e.state,
      error: e.error,
      progress: e.progress,
      report: e.report ? (details ? e.report : summarize(e.report)) : undefined,
    };
  }
  cancelRun(id: string) {
    const e = this.runs.get(id);
    if (!e) throw new HarnessError("NOT_FOUND", "Unknown run");
    e.controller.abort();
    return { id, cancellationRequested: true };
  }
  async openSession(input: unknown) {
    this.reserve();
    const spec = caseSchema.parse(input),
      id = randomUUID();
    this.pending++;
    let writer: ContentProvider | undefined;
    let provider: DecisionProvider | undefined,
      session: HarnessSession | undefined;
    const controller = new AbortController();
    let finish!: () => void;
    this.openings.set(
      controller,
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    try {
      const platform = this.options.platforms.create(spec);
      provider = this.options.provider();
      writer = spec.content?.enabled
        ? this.options.contentProvider?.()
        : undefined;
      session = new HarnessSession(spec, {
        provider,
        contentProvider: writer,
        platform,
        artifactsDir: this.out(id),
        maxDurationMs: this.options.maxDurationMs ?? 1800000,
        signal: controller.signal,
      });
      await session.open();
      if (this.closing)
        throw new HarnessError("SERVICE_CLOSED", "Service is shutting down");
      this.sessions.set(id, {
        session,
        provider,
        writer,
        touched: Date.now(),
        busy: false,
        controller,
      });
      return { id, ...(await this.inspect(id)) };
    } catch (error) {
      this.sessions.delete(id);
      await session?.close(false).catch(() => {});
      await provider?.close?.();
      await writer?.close?.();
      throw error;
    } finally {
      this.pending--;
      this.openings.delete(controller);
      finish();
    }
  }
  private entry(id: string) {
    const e = this.sessions.get(id);
    if (!e) throw new HarnessError("NOT_FOUND", "Unknown or expired session");
    e.touched = Date.now();
    return e;
  }
  private async exclusive<T>(
    id: string,
    action: (e: SessionEntry) => Promise<T>,
  ) {
    const e = this.entry(id);
    if (e.busy)
      throw new HarnessError(
        "SESSION_BUSY",
        "Session already has an active operation",
      );
    e.busy = true;
    try {
      e.operation = action(e);
      return (await e.operation) as T;
    } finally {
      e.operation = undefined;
      e.busy = false;
      e.touched = Date.now();
    }
  }
  inspect(id: string) {
    return this.exclusive(id, async (e) => {
      const o = await e.session.inspect();
      return {
        url: o.url,
        title: o.title,
        text: o.text?.slice(0, 8000),
        dialogs: o.dialogs,
        controls: o.elements
          .filter((c) => c.visible)
          .slice(0, 80)
          .map((c) => ({
            name: c.name,
            role: c.role,
            context: c.context,
            disabled: c.disabled,
          })),
        usage: e.session.report.usage,
      };
    });
  }
  screenshot(id: string) {
    return this.exclusive(id, async (e) => {
      const path = await e.session.capture();
      if ((await stat(path)).size > 8 * 1024 * 1024)
        throw new HarnessError("IMAGE_TOO_LARGE", "Screenshot exceeds 8 MiB");
      return {
        mimeType: "image/png",
        data: (await readFile(path)).toString("base64"),
      };
    });
  }
  step(id: string, step: StepInstruction) {
    return this.exclusive(id, (e) => e.session.step(step));
  }
  retry(id: string, step?: StepInstruction) {
    return this.exclusive(id, (e) => e.session.retry(step));
  }
  confirm(id: string, step: StepInstruction) {
    return this.exclusive(id, (e) => e.session.confirm(step));
  }
  async closeSession(id: string) {
    return this.exclusive(id, async (e) => {
      try {
        return summarize(await e.session.close());
      } finally {
        this.sessions.delete(id);
        await e.provider.close?.();
        await e.writer?.close?.();
      }
    });
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    for (const controller of this.openings.keys()) controller.abort();
    await Promise.allSettled(this.openings.values());
    for (const e of this.runs.values())
      if (e.state === "running") e.controller.abort();
    for (const e of this.sessions.values()) if (e.busy) e.controller.abort();
    await Promise.allSettled([...this.runs.values()].map((e) => e.done));
    await Promise.allSettled(
      [...this.sessions.values()].map((e) => e.operation),
    );
    await Promise.allSettled(
      [...this.sessions].map(async ([id, e]) => {
        if (e.busy) {
          await e.session.close(false);
          await e.provider.close?.();
          await e.writer?.close?.();
          this.sessions.delete(id);
        } else await this.closeSession(id);
      }),
    );
  }
}
