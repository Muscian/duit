import "../load-env.js";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import {
  HarnessError,
  operations,
  type Operation,
  type CaseSpec,
} from "./types.js";

const httpUrl = z
  .string()
  .url()
  .refine(
    (v) => ["http:", "https:"].includes(new URL(v).protocol),
    "Use http(s)",
  );
export const assertionWaitSchema = z
  .object({
    timeoutMs: z.number().int().min(250).max(300000),
    intervalMs: z.number().int().min(250).max(30000).optional(),
    refreshPage: z.boolean().optional(),
    refreshControl: z.string().trim().min(1).max(300).optional(),
  })
  .strict()
  .refine((wait) => !(wait.refreshPage && wait.refreshControl), {
    message: "Choose refreshPage or refreshControl, not both",
  });
export const stepSchema = z.union([
  z.string().trim().min(1).max(2000),
  z
    .object({
      instruction: z.string().trim().min(1).max(2000),
      operation: z
        .enum(
          Object.keys(operations).filter((k) => k !== "unsupported") as [
            Operation,
            ...Operation[],
          ],
        )
        .optional(),
      value: z.string().max(10000).optional(),
      count: z.number().int().min(0).max(10000).optional(),
      control: z
        .object({
          name: z.string().min(1).max(500),
          role: z.string().min(1).max(100).optional(),
        })
        .strict()
        .optional(),
      visual: z.enum(["fallback", "only", "off"]).optional(),
      generate: z
        .object({
          prompt: z.string().min(1).max(4000),
          maxChars: z.number().int().min(1).max(10000).optional(),
        })
        .strict()
        .optional(),
      wait: assertionWaitSchema.optional(),
      context: z
        .object({ urlIncludes: z.string().min(1), text: z.string().min(1) })
        .partial()
        .strict()
        .optional(),
      scope: z.string().trim().min(1).max(500).optional(),
      aliases: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
    })
    .strict(),
]);
export const caseSchema = z
  .object({
    interaction: z
      .object({
        profile: z.enum(["manual", "test"]).optional(),
        cookies: z.enum(["manual", "accept", "reject"]).optional(),
        onboarding: z.enum(["manual", "dismiss"]).optional(),
        reminders: z.enum(["manual", "later"]).optional(),
        unsavedChanges: z.enum(["manual", "discard"]).optional(),
        maxActions: z.number().int().min(1).max(30).optional(),
        exactLabelWaitMs: z.number().int().min(0).max(30000).optional(),
      })
      .strict()
      .optional(),
    decisionContext: z.string().trim().min(1).max(2000).optional(),
    privacy: z
      .object({
        mode: z.enum(["standard", "restricted", "local"]).optional(),
        redact: z.array(z.string().min(1).max(10000)).max(100).optional(),
      })
      .strict()
      .optional(),
    name: z.string().trim().min(1).max(200),
    content: z
      .object({
        enabled: z.boolean(),
        maxRequests: z.number().int().positive().max(100),
        maxUsd: z.number().positive(),
        inputPerMillion: z.number().nonnegative(),
        outputPerMillion: z.number().nonnegative(),
        maxOutputTokens: z.number().int().min(1).max(4096).optional(),
      })
      .strict()
      .optional(),
    platform: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional(),
    visual: z
      .object({
        enabled: z.boolean(),
        minConfidence: z.number().min(0).max(1).optional(),
        minProbability: z.number().min(0).max(1).optional(),
        maxCalls: z.number().int().min(1).max(100).optional(),
      })
      .strict()
      .optional(),
    costs: z
      .object({
        maxRequests: z.number().int().positive().optional(),
        maxInputTokens: z.number().int().positive().optional(),
        maxUsd: z.number().positive().optional(),
        inputPerMillion: z.number().nonnegative().optional(),
        outputPerMillion: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    baseUrl: httpUrl,
    steps: z.array(stepSchema).min(1).max(200),
    cleanup: z.array(stepSchema).max(50).optional(),
    browser: z
      .object({
        allowedOrigins: z.array(httpUrl).max(20).optional(),
        localNetworkOrigins: z.array(httpUrl).max(20).optional(),
        channel: z.enum(["chrome", "chromium", "msedge"]).optional(),
        timeoutMs: z.number().int().positive().max(300000).optional(),
        navigationTimeoutMs: z.number().int().positive().max(300000).optional(),
      })
      .strict()
      .optional(),
    publicVariables: z.array(z.string()).max(100).optional(),
    interruptions: z
      .array(
        z
          .object({
            name: z.string().min(1).max(100),
            when: z
              .object({
                text: z.string().min(1).max(500),
                urlIncludes: z.string().min(1).optional(),
              })
              .strict(),
            action: z.string().min(1).max(2000),
            maxRuns: z.number().int().min(1).max(5).optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
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
          'Use quotes around the exact value, e.g. Type "Ana" into the Name field.',
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
  minimizeUrls = false,
) {
  const secrets = [...Object.values(variables), ...additional]
    .filter(Boolean)
    .flatMap((s) => [
      s,
      encodeURIComponent(s),
      new URLSearchParams({ value: s }).toString().slice(6),
    ])
    .sort((a, b) => b.length - a.length);
  const clean = (value: string) => {
    let result = secrets.reduce(
      (s, secret) => s.split(secret).join("[REDACTED]"),
      value,
    );
    if (minimizeUrls)
      result = result.replace(/https?:\/\/[^\s<>"']+/g, (url) => {
        try {
          return new URL(url).origin;
        } catch {
          return "[URL]";
        }
      });
    return result;
  };
  return (value: string) => {
    // Redact decoded JSON strings too: quotes, backslashes and newlines in secrets
    // must neither evade masking nor corrupt a serialized report/request.
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object") return clean(value);
      const walk = (v: unknown): unknown =>
        typeof v === "string"
          ? clean(v)
          : Array.isArray(v)
            ? v.map(walk)
            : v && typeof v === "object"
              ? Object.fromEntries(
                  Object.entries(v).map(([k, x]) => [k, walk(x)]),
                )
              : v;
      return JSON.stringify(
        walk(parsed),
        null,
        value.includes("\n") ? 2 : undefined,
      );
    } catch {
      return clean(value);
    }
  };
}
