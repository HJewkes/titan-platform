import type { StepResult } from "@titan-design/workflow";
import { z } from "zod";
import { MEETER_SHAPES, type AttestedSchema } from "./attest-schema.js";
import { MERGE_EVIDENCE_STEP } from "./merge-facts.js";

type AttestedLine = z.infer<typeof AttestedSchema>[number];

const MetRow = z.looseObject({ step: z.string(), closure: z.string(), meeters: z.array(z.looseObject({ name: z.string(), shape: z.enum(MEETER_SHAPES) })) });
const AttestedRecord = z.looseObject({ result: z.looseObject({ record: z.looseObject({ attested: z.array(MetRow) }) }) });

/** The watch row's `attested` field from the newest evidence that met a row; absent when no evidence did. */
export function attestedField(steps: readonly StepResult[]): { attested?: AttestedLine[] } {
  const evidence = steps.filter((result) => result.stepId.startsWith(`${MERGE_EVIDENCE_STEP}:`)).flatMap((result) => {
    const parsed = AttestedRecord.safeParse(result.data);
    return parsed.success && parsed.data.result.record.attested.length > 0 ? [{ at: result.completedAt, met: parsed.data.result.record.attested }] : [];
  }).at(-1);
  if (evidence === undefined) return {};
  return { attested: evidence.met.map(({ step, closure, meeters }) => ({ step, closure, meeters: meeters.map(({ name, shape }) => ({ name, shape })), at: evidence.at })) };
}
