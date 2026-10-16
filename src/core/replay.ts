import { z } from "zod";
import {
  operations,
  type ResolvedAction,
  type Operation,
  valueOperations,
  pageOperations,
} from "./types.js";
import { caseSchema } from "./input.js";
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
    operation: z.enum(
      Object.keys(operations).filter((x) => x !== "unsupported") as [
        Operation,
        ...Operation[],
      ],
    ),
    value: z.string().max(10000).optional(),
    target: locatorSchema.optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
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
      actions: z.array(actionSchema).min(1).max(100),
    })
    .strict()
    .parse(raw);
  return { ...parsed, actions: parsed.actions as ResolvedAction[] };
}
