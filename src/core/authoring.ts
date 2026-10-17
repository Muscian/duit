import { z } from "zod";
import { caseSchema, literalCandidates } from "./input.js";
import { valueOperations, type CaseSpec } from "./types.js";

export const caseJsonSchema = () => z.toJSONSchema(caseSchema);
export function validateCase(input: unknown) {
  const parsed = caseSchema.safeParse(input);
  if (!parsed.success)
    return {
      valid: false,
      errors: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
      hints: [] as string[],
    };
  const hints: string[] = [];
  const steps = [...parsed.data.steps, ...(parsed.data.cleanup ?? [])];
  for (const [i, s] of steps.entries()) {
    const text = typeof s === "string" ? s : s.instruction;
    if (
      typeof s !== "string" &&
      s.operation &&
      valueOperations.has(s.operation) &&
      s.value === undefined &&
      !literalCandidates(text).length
    )
      hints.push(
        `Step ${i + 1}: provide a literal value or variable reference`,
      );
    if (/\b(and then|then click|y luego)\b/i.test(text))
      hints.push(`Step ${i + 1}: split compound actions into separate steps`);
  }
  if (
    !parsed.data.steps.some(
      (s) =>
        (typeof s !== "string" && s.operation?.startsWith("assert_")) ||
        /verify|assert|verifica|comprueba/i.test(
          typeof s === "string" ? s : s.instruction,
        ),
    )
  )
    hints.push(
      "Add an explicit assertion; actions alone cannot establish success",
    );
  if (parsed.data.visual?.enabled)
    hints.push(
      "Visual fallback sends masked viewport images to Jev; clicks only, current viewport only, no visual replay",
    );
  return { valid: true, errors: [], hints };
}

/** An authoring LLM supplies concrete field values here, never executable code or selectors. */
export function materializeFields(
  input: unknown,
  fields: Array<{ step: number; value: string }>,
): CaseSpec {
  const spec = caseSchema.parse(input);
  const seen = new Set<number>();
  for (const field of fields) {
    if (
      !Number.isInteger(field.step) ||
      field.step < 1 ||
      field.step > spec.steps.length ||
      seen.has(field.step)
    )
      throw new Error("Field step must be a unique 1-based main-step index");
    if (typeof field.value !== "string" || field.value.length > 10000)
      throw new Error("Field value must be text of at most 10000 characters");
    seen.add(field.step);
    const original = spec.steps[field.step - 1];
    if (typeof original === "string" || original.operation !== "fill")
      throw new Error("Materialization requires an explicit fill operation");
    spec.steps[field.step - 1] = {
      ...original,
      generate: undefined,
      value: field.value,
    };
  }
  return caseSchema.parse(spec);
}
