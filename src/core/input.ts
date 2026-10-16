import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { HarnessError, type CaseSpec } from "./types.js";

const httpUrl = z
  .string()
  .url()
  .refine(
    (v) => ["http:", "https:"].includes(new URL(v).protocol),
    "Use http(s)",
  );
export const caseSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    baseUrl: httpUrl,
    steps: z.array(z.string().trim().min(1).max(2000)).min(1).max(100),
    variables: z
      .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
      .default({}),
  })
  .strict();

export function parseCase(
  source: string,
  options: { baseUrl?: string; name?: string; plainText?: boolean } = {},
): CaseSpec {
  if (options.plainText) {
    const lines = source
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
    return caseSchema.parse({
      name: options.name ?? "Natural-language test",
      baseUrl: options.baseUrl,
      steps: lines.map((s) => s.replace(/^(?:\d+[.)]|[-*])\s+/, "")),
    });
  }
  const input = parse(source);
  return caseSchema.parse({
    ...input,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  });
}
export async function loadCase(
  file: string,
  baseUrl?: string,
): Promise<CaseSpec> {
  return parseCase(await readFile(file, "utf8"), {
    baseUrl,
    plainText: /\.(txt|md)$/i.test(file),
  });
}

// Candidate strings are copied verbatim; the model cannot generate or modify them.
export function literalCandidates(text: string): string[] {
  const quoted = [
    ...text.matchAll(/"([^"\n]*)"|'([^'\n]*)'|“([^”\n]*)”|`([^`\n]*)`/g),
  ].map((m) => m.slice(1).find((v) => v !== undefined)!);
  const references = [...text.matchAll(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g)].map(
    (m) => m[0],
  );
  if (quoted.length || references.length)
    return [...new Set([...quoted, ...references])];
  const words = [...text.matchAll(/\S+/g)];
  const spans = new Set<string>();
  for (let size = 1; size <= Math.min(8, words.length); size++) {
    for (let i = 0; i + size <= words.length; i++) {
      const first = words[i],
        last = words[i + size - 1];
      spans.add(text.slice(first.index, last.index! + last[0].length));
      if (spans.size > 240)
        throw new HarnessError(
          "VALUE_SPACE_TOO_LARGE",
          'Use quotes around the exact value, e.g. Escribí "Ana" en Nombre.',
        );
    }
  }
  return [...spans];
}

export function resolveVariables(
  variables: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(variables).map(([key, value]) => {
      if (!value.startsWith("env:")) return [key, value];
      const resolved = env[value.slice(4)];
      if (resolved === undefined)
        throw new HarnessError(
          "MISSING_VARIABLE",
          `Environment variable ${value.slice(4)} is not set`,
        );
      return [key, resolved];
    }),
  );
}
export function substitute(
  value: string,
  variables: Record<string, string>,
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
    if (!(key in variables))
      throw new HarnessError(
        "MISSING_VARIABLE",
        `Variable ${key} is not defined`,
      );
    return variables[key];
  });
}
export function redactor(
  variables: Record<string, string>,
  additional: string[] = [],
) {
  const secrets = [...Object.values(variables), ...additional]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  return (value: string) =>
    secrets.reduce((s, secret) => s.split(secret).join("[REDACTED]"), value);
}
