import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type RunReport, type ResolvedAction, type CaseSpec } from "./types.js";

export type ReplayPlan = {
  version: 1;
  name: string;
  baseUrl: string;
  variables: Record<string, string>;
  actions: ResolvedAction[];
};
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export async function saveArtifacts(
  report: RunReport,
  spec: CaseSpec,
  actions: ResolvedAction[],
  sanitize: (s: string) => string,
) {
  const reportJson = sanitize(JSON.stringify(report, null, 2));
  await writeFile(join(report.artifactsDir, "report.json"), reportJson);
  // Values stay as variable references. Inline fixture variables are intentionally excluded from replay artifacts.
  if (report.status === "passed") {
    const plan: ReplayPlan = {
      version: 1,
      name: spec.name,
      baseUrl: spec.baseUrl,
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
  const failures = safe.status === "passed" ? 0 : 1;
  const details = safe.error ?? safe.steps.find((s) => s.error)?.error ?? "";
  await writeFile(
    join(report.artifactsDir, "junit.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="1" failures="${failures}"><testsuite name="duit" tests="1" failures="${failures}"><testcase name="${escape(safe.name)}" time="${safe.durationMs / 1000}">${failures ? `<failure type="${safe.status}" message="${escape(details)}"/>` : ""}</testcase></testsuite></testsuites>\n`,
  );
  await writeFile(
    join(report.artifactsDir, "report.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(safe.name)} · duit</title><style>body{font:16px system-ui;background:#10141d;color:#e6eaf2;max-width:1000px;margin:40px auto;padding:0 24px}h1{font-size:32px}article{background:#1a2130;padding:20px;border-radius:10px;margin:16px 0}small{color:#a8b8cf}pre{white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:100%;border-radius:6px}a{color:#9ecbff}.passed{color:#78e7ae}.failed,.blocked{color:#ff9b9b}</style><h1>${escape(safe.name)}</h1><p class="${safe.status}">${safe.status.toUpperCase()} · ${(safe.durationMs / 1000).toFixed(2)} s · ${safe.mode}</p><small>${escape(safe.startedAt)} · ${safe.decisions.length} model requests</small>${safe.error ? `<pre>${escape(safe.error)}</pre>` : ""}${safe.steps.map((s) => `<article><b class="${s.status}">${s.index + 1}. ${s.status}</b><p>${escape(s.text)}</p><small>${s.durationMs} ms · ${escape(s.action?.operation ?? "unresolved")}</small>${s.error ? `<pre>${escape(s.error)}</pre>` : ""}${s.screenshot ? `<details><summary>Screenshot</summary><img src="${escape(s.screenshot)}" alt="Step ${s.index + 1}"></details>` : ""}</article>`).join("")}<p>${safe.warnings.map(escape).join("<br>")}</p><p><a href="report.json">JSON</a> · <a href="junit.xml">JUnit</a>${safe.status === "passed" ? ' · <a href="replay.json">Replay plan</a>' : ""}</p></html>`,
  );
}
