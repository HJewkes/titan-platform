import { canonicalJson, caseHash, pinSuitePrompts, pinVariantPrompts, scorecardKeyHash, suiteHash, unitHash, variantHash } from "./hash.js";
import type { ReadPrompt } from "./hash.js";
import { parseSpec } from "./spec/index.js";
import type { Spec } from "./spec/index.js";

export interface SpecValidation {
  schema: Spec["schema"];
  /** The spec's content hash; for a scorecard, the hash of its key. */
  hash: string;
  /** True when a stored prompt digest no longer matches the file it names. */
  stalePrompts: boolean;
}

/** Strict-parses a spec, re-reads the prompts it references and hashes the pinned result. */
export async function validateSpec(value: unknown, read: ReadPrompt): Promise<SpecValidation> {
  const spec = parseSpec(value, "strict");
  const pinned = await pinPrompts(spec, read);
  return { schema: spec.schema, hash: hashSpec(pinned), stalePrompts: canonicalJson(pinned) !== canonicalJson(spec) };
}

async function pinPrompts(spec: Spec, read: ReadPrompt): Promise<Spec> {
  if (spec.schema === "titan.variant/v1") return pinVariantPrompts(spec, read);
  if (spec.schema === "titan.suite/v1") return pinSuitePrompts(spec, read);
  return spec;
}

export function hashSpec(spec: Spec): string {
  switch (spec.schema) {
    case "titan.unit/v1": return unitHash(spec);
    case "titan.variant/v1": return variantHash(spec);
    case "titan.case/v1": return caseHash(spec);
    case "titan.suite/v1": return suiteHash(spec);
    case "titan.scorecard/v1": return scorecardKeyHash(spec.keys);
  }
}
