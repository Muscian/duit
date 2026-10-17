import { z } from "zod";
import {
  operations,
  type ResolvedAction,
  type Operation,
  valueOperations,
  pageOperations,
} from "./types.js";
import { caseSchema, assertionWaitSchema } from "./input.js";
import { type ReplayPlan } from "./artifacts.js";
const locatorSchema = z
  .object({
    frame: z.number().int().min(0).max(100),
    kind: z.enum(["testId", "label", "role", "css"]),
    value: z.string().min(1).max(2000),
    name: z.string().max(500).optional(),
  })
  .strict();
const actionSchema = z
  .object({
    text: z.string().min(1).max(2000),
    wait: assertionWaitSchema.optional(),
    context: z
      .object({
        urlIncludes: z.string().optional(),
        text: z.string().optional(),
      })
      .strict()
      .optional(),
    scope: z.string().optional(),
    aliases: z.array(z.string()).optional(),
    operation: z.enum(
      Object.keys(operations).filter((x) => x !== "unsupported") as [
        Operation,
        ...Operation[],
      ],
    ),
    value: z.string().max(10000).optional(),
    target: locatorSchema.optional(),
    resolution: z.enum(["exact-label", "jev"]).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.wait && !a.operation.startsWith("assert_"))
      ctx.addIssue({
        code: "custom",
        message: "Only assertions can be polled",
      });
    if (valueOperations.has(a.operation) && a.value === undefined)
      ctx.addIssue({
        code: "custom",
        message: "Operation requires a literal value",
      });
    if (!pageOperations.has(a.operation) && !a.target)
      ctx.addIssue({ code: "custom", message: "Operation requires a target" });
  });
export function parseReplay(raw: unknown): ReplayPlan {
  const parsed = z
    .object({
      version: z.literal(1),
      name: caseSchema.shape.name,
      baseUrl: caseSchema.shape.baseUrl,
      variables: caseSchema.shape.variables,
      browser: caseSchema.shape.browser,
      publicVariables: caseSchema.shape.publicVariables,
      actions: z.array(actionSchema).min(1).max(400),
    })
    .strict()
    .parse(raw);
  return { ...parsed, actions: parsed.actions as ResolvedAction[] };
}
