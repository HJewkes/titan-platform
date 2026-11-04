import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SampleCase } from "./samples-measure.js";

/** The fields of an ev `titan.case/v1` file a sample run reads; ev itself validates the rest. */
const CaseFileSchema = z.object({
  schema: z.literal("titan.case/v1"),
  id: z.string().min(1),
  input: z.object({ inputs: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)) }),
  split: z.string().optional(),
});

const caseFiles = (target: string): string[] =>
  statSync(target).isDirectory()
    ? readdirSync(target).filter((name) => name.endsWith(".json")).sort().map((name) => path.join(target, name))
    : [target];

/** Reads ev case files, or every `.json` in a cases directory, keeping those in `split` (all when undefined). */
export function loadCases(targets: readonly string[], split: string | undefined): SampleCase[] {
  const parsed = targets.flatMap(caseFiles).map((file) => {
    const result = CaseFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!result.success) throw new Error(`${file} is not a titan.case/v1 file with input.inputs: ${result.error.issues[0]?.message ?? "invalid"}`);
    return result.data;
  });
  const cases = parsed.filter((c) => split === undefined || c.split === split).map((c) => ({ name: c.id, inputs: c.input.inputs }));
  const names = cases.map((c) => c.name);
  if (new Set(names).size !== names.length) throw new Error(`two cases share an id: ${names.join(", ")}`);
  if (cases.length === 0) throw new Error(`no case${split === undefined ? "" : ` in split "${split}"`} among ${targets.join(", ")}`);
  return cases;
}
