import { privateReport } from "./privacy.js";
import { updateFailureReport } from "./failures.js";
import { writeFile as fsWriteFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { type RunReport, type ResolvedAction, type CaseSpec } from "./types.js";

const writeFile = (path: string, data: string) =>
  fsWriteFile(path, data, { mode: 0o600 });

export type ReplayPlan = {
  version: 1;
  name: string;
  baseUrl: string;
  variables: Record<string, string>;
  browser?: CaseSpec["browser"];
  publicVariables?: string[];
  actions: ResolvedAction[];
};
const escape = (s: string) =>
  s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
export async function saveArtifacts(
  report: RunReport,
  spec: CaseSpec,
  actions: ResolvedAction[],
  sanitize: (s: string) => string,
) {
  if (
    actions.some((a) => a.visualTarget) &&
    !report.warnings.includes(
      "Visual coordinates are snapshot-bound; no replay plan exported.",
    )
  )
    report.warnings.push(
      "Visual coordinates are snapshot-bound; no replay plan exported.",
    );
  updateFailureReport(report);
  const replayable =
    report.privacy?.detailedArtifacts !== false &&
    !actions.some((a) => a.visualTarget);
  const reportJson = sanitize(JSON.stringify(privateReport(report), null, 2));
  await writeFile(join(report.artifactsDir, "report.json"), reportJson);
  // Values stay as variable references. Inline fixture variables are intentionally excluded from replay artifacts.
  if (
    report.status === "passed" &&
    report.mode !== "interactive" &&
    replayable
  ) {
    const plan: ReplayPlan = {
      version: 1,
      name: spec.name,
      baseUrl: spec.baseUrl,
      browser: spec.browser,
      publicVariables: spec.publicVariables,
      variables: Object.fromEntries(
        Object.entries(spec.variables).map(([k, v]) => [
          k,
          v.startsWith("env:") ? v : `env:${k}`,
        ]),
      ),
      actions,
    };
    await writeFile(
      join(report.artifactsDir, "replay.json"),
      sanitize(JSON.stringify(plan, null, 2)),
    );
  }
  const safe = JSON.parse(reportJson) as RunReport;
  await writeFile(
    join(report.artifactsDir, "agent-report.json"),
    JSON.stringify(safe.agent, null, 2),
  );
  const failures = safe.status === "passed" ? 0 : 1;
  const details =
    safe.error ??
    safe.steps.find((s) => s.error && s.recoveredBy === undefined)?.error ??
    safe.cleanup?.find((s) => s.error)?.error ??
    "";
  await writeFile(
    join(report.artifactsDir, "junit.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="1" failures="${failures}"><testsuite name="duit" tests="1" failures="${failures}"><testcase name="${escape(safe.name)}" time="${safe.durationMs / 1000}">${failures ? `<failure type="${escape(safe.agent?.failures[0]?.code ?? safe.status)}" message="${escape(details)}">${escape(JSON.stringify(safe.agent))}</failure>` : ""}</testcase></testsuite></testsuites>\n`,
  );
  await writeFile(
    join(report.artifactsDir, "report.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(safe.name)} · duit</title><style>body{font:16px system-ui;background:#10141d;color:#e6eaf2;max-width:1000px;margin:40px auto;padding:0 24px}h1{font-size:32px}article{background:#1a2130;padding:20px;border-radius:10px;margin:16px 0}small{color:#a8b8cf}pre{white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%;border-radius:6px}a{color:#9ecbff}.passed{color:#78e7ae}.failed,.blocked{color:#ff9b9b}</style><h1>${escape(safe.name)}</h1><p class="${safe.status}">${safe.status.toUpperCase()} · ${(safe.durationMs / 1000).toFixed(2)} s · ${safe.mode}</p><small>${escape(safe.startedAt)} · ${safe.usage?.requests ?? safe.decisions.length} Jev requests</small>${safe.contentUsage?.requests ? `<p>Writer: ${safe.contentUsage.requests} calls · Estimated USD ${safe.contentUsage.estimatedUsd.toFixed(8)}${safe.contentUsage.complete ? "" : " (incomplete usage)"}</p>` : ""}${safe.usage ? `<p>Model calls: ${safe.usage.requests} · Input tokens: ${safe.usage.inputTokens} · Output tokens: ${safe.usage.outputTokens} · Estimated USD: ${safe.usage.estimatedUsd?.toFixed(8) ?? "unknown"}${safe.usage.complete ? "" : " (incomplete usage)"}</p><details><summary>Pricing and visual decisions</summary><pre>${escape(JSON.stringify({ usage: safe.usage, contentUsage: safe.contentUsage, visual: safe.visualDecisions }, null, 2))}</pre></details>` : ""}${safe.agent ? `<details open><summary>Recovery and pipeline outcome</summary><pre>${escape(JSON.stringify(safe.agent, null, 2))}</pre></details>` : ""}${safe.error ? `<pre>${escape(safe.error)}</pre>` : ""}${safe.screenshot ? `<details><summary>Startup screenshot</summary><img src="${escape(safe.screenshot)}" alt="Startup state"></details>` : ""}${safe.diagnostics ? `<details><summary>Connection and network diagnostics</summary><pre>${escape(JSON.stringify(safe.diagnostics, null, 2))}</pre></details>` : ""}${safe.interruptions?.length ? `<details><summary>Handled interruptions</summary><pre>${escape(JSON.stringify(safe.interruptions, null, 2))}</pre></details>` : ""}${safe.cleanup?.length ? `<details><summary>Cleanup</summary><pre>${escape(JSON.stringify(safe.cleanup, null, 2))}</pre></details>` : ""}${safe.steps.map((s) => `<article><b class="${s.status}">${s.index + 1}. ${s.status}</b><p>${escape(s.text)}</p><small>${s.durationMs} ms · ${escape(s.action?.operation ?? "unresolved")} · ${escape(s.action?.resolution ?? "page operation")}</small>${s.recoveredBy !== undefined ? `<p>Recovered by step ${s.recoveredBy + 1}</p>` : ""}${s.error ? `<pre>${escape(s.error)}</pre>` : ""}${s.evidence ? `<details><summary>Page and available controls (${escape(s.phase ?? "unknown phase")})</summary><pre>${escape(JSON.stringify(s.evidence, null, 2))}</pre></details>` : ""}${s.visualScreenshot ? `<details><summary>Visual decision viewport</summary><img src="${escape(s.visualScreenshot)}" alt="Viewport used for visual decision"><pre>${escape(JSON.stringify(s.action?.visualTarget, null, 2) ?? "")}</pre></details>` : ""}${s.screenshot ? `<details><summary>Screenshot</summary><img src="${escape(s.screenshot)}" alt="Step ${s.index + 1}"></details>` : ""}</article>`).join("")}<p>${safe.warnings.map(escape).join("<br>")}</p><p><a href="agent-report.json">Agent report</a> · <a href="report.json">JSON</a> · <a href="junit.xml">JUnit</a>${safe.status === "passed" && safe.mode !== "interactive" && replayable ? ' · <a href="replay.json">Replay plan</a>' : ""}</p></html>`,
  );
}

export async function saveCheckpoint(
  report: RunReport,
  sanitize: (s: string) => string,
  lifecycle: "open" | "closed" = "open",
) {
  updateFailureReport(report);
  report = privateReport(report);
  const path = join(report.artifactsDir, "checkpoint.json");
  const contents = {
    version: 1,
    lifecycle,
    agent: report.agent,
    url: report.diagnostics?.url,
    steps: report.steps.map(
      ({ index, text, status, phase, recoveredBy, retryOf }) => ({
        index,
        text,
        status,
        phase,
        recoveredBy,
        retryOf,
      }),
    ),
    cleanup: report.cleanup,
    interruptions: report.interruptions,
    instructions:
      "A dispatch without a completed result is uncertain, including interruption handlers marked dispatched. Inspect the UI before continuing. This checkpoint must never be replayed as an action plan.",
  };
  await writeFile(path + ".tmp", sanitize(JSON.stringify(contents, null, 2)));
  await rename(path + ".tmp", path);
}
