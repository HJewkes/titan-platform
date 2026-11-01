import { createHash } from "node:crypto";
import { z } from "zod";
import { declarationFor } from "../definition.js";
import { entryProblems, isFactEntry, type FactEntry, type StepEntry } from "./entry.js";
import { factRule, type PinClass } from "./pin-classes.js";

interface StepRegistry {
  readonly entries: readonly StepEntry[];
}

/** Refuses an entry the meta-schema rejects, a reused name, and a fact the pin-class rule file does not name. */
export function createRegistry(entries: readonly StepEntry[]): StepRegistry {
  const names = new Set<string>();
  for (const entry of entries) {
    const problems = entryProblems(entry);
    if (problems) throw new Error(`step registry: entry "${String(entry.name)}" is invalid: ${problems}`);
    if (names.has(entry.name)) throw new Error(`step registry: two entries are named "${entry.name}"`);
    names.add(entry.name);
    if (isFactEntry(entry) && !factRule(entry.fact)) {
      throw new Error(`step registry: entry "${entry.name}" names fact "${entry.fact}", which the pin-class rule file does not list`);
    }
  }
  return { entries: [...entries] };
}

/** The entry covering `stepId`, by declarationFor's longest-match rule, so `ci-wait:2` resolves to `ci-wait`. */
export function entryFor(registry: StepRegistry, stepId: string): StepEntry | undefined {
  const declaration = declarationFor(
    registry.entries.map((entry) => ({ id: entry.name, kind: entry.op })),
    stepId,
  );
  return declaration && registry.entries.find((entry) => entry.name === declaration.id);
}

/** The fact entry's pin class, read from the rule file; `visual` picks a row's visual class where it has one. */
export function pinClassOf(entry: FactEntry, options: { visual: boolean }): PinClass {
  const rule = factRule(entry.fact);
  if (!rule) throw new Error(`step registry: fact "${entry.fact}" is not in the pin-class rule file`);
  return options.visual && rule.visualPinClass ? rule.visualPinClass : rule.pinClass;
}

/** sha256 over the canonical JSON Schema of the entry's input and output: a schema change moves it, a rename does not. */
export function schemaHash(entry: FactEntry): string {
  const schemas = { input: z.toJSONSchema(entry.input), output: z.toJSONSchema(entry.output) };
  return createHash("sha256").update(canonicalJson(schemas)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
