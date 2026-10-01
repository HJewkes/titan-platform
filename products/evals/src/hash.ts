import { createHash } from "node:crypto";
import type { CheckSpec, EvalCase, Scorecard, StepSpec, SuiteSpec, UnitSpec, VariantSpec } from "./spec/index.js";

/** Reads a prompt file by its spec-relative path. */
export type ReadPrompt = (path: string) => Promise<string | Uint8Array>;

interface PromptRef {
  path: string;
  sha256: string;
}

/** Sorted keys, no whitespace, undefined members dropped; anything that would not survive JSON is refused. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value !== "object" || !isPlainObject(value)) throw new TypeError(`canonical JSON accepts only JSON-safe values, got ${String(value)}`);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, normalize(item)]),
  );
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Fields each hash leaves out; every other field is hashed, so a new schema field joins the identity by default.
 * Unit: prose, the owner's acceptance ladder and publishing state do not change what a run measures.
 * Case: names, labels and annotations; the suite, not the case, binds a case to a unit and a split.
 * Variant: names and lineage. Suite: names and version text. Scorecard key: the environment, which warns rather than splits.
 * Locations (prompt and fixture paths, skill sources, the topology module path) are dropped inside the hashed fields.
 */
export const HASH_EXCLUDED_FIELDS = {
  unit: ["title", "description", "acceptance", "visibility"],
  case: ["id", "unit", "split", "tags", "humanMinutes", "solvable", "visibility"],
  variant: ["id", "notes", "parents"],
  suite: ["id", "version"],
  scorecardKey: ["env"],
} as const satisfies Record<string, readonly string[]>;

function omit(value: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

/** Hashes expect parsed specs: parsing fills defaults such as `trials` and a check's `scope`. */
export function unitHash(unit: UnitSpec): string {
  return hashCanonical(omit(unit, HASH_EXCLUDED_FIELDS.unit));
}

export function caseHash(evalCase: EvalCase): string {
  const { fixture, provenance } = evalCase;
  return hashCanonical({
    ...omit(evalCase, HASH_EXCLUDED_FIELDS.case),
    fixture: fixture && omit(fixture, ["path"]),
    provenance: omit(provenance, ["source", "ref"]),
  });
}

/** Covers code and content, never locations: a moved prompt or skill keeps its hash. */
export function variantHash(variant: VariantSpec): string {
  const steps = Object.fromEntries(Object.entries(variant.steps).map(([id, step]) => [id, stepContentOf(step)]));
  return hashCanonical({ ...omit(variant, HASH_EXCLUDED_FIELDS.variant), topology: omit(variant.topology, ["module"]), steps });
}

function stepContentOf(step: StepSpec): unknown {
  if (step.kind === "llm") return { ...step, prompt: step.prompt.sha256 };
  if (step.kind !== "agent") return step;
  return {
    ...step,
    prompt: step.prompt.sha256,
    systemPrompt: step.systemPrompt?.sha256,
    skills: step.skills.map((skill) => omit(skill, ["source"])),
  };
}

export function suiteHash(suite: SuiteSpec): string {
  const { cases, checks, simulatedOwner } = suite;
  const owner = simulatedOwner?.kind === "persona" ? { ...simulatedOwner, prompt: simulatedOwner.prompt.sha256 } : simulatedOwner;
  return hashCanonical({
    ...omit(suite, HASH_EXCLUDED_FIELDS.suite),
    cases: [...cases].sort(),
    checks: checks.map(checkContentOf),
    simulatedOwner: owner,
  });
}

export function judgesHash(suite: SuiteSpec): string {
  return hashCanonical(suite.checks.filter((check) => check.family === "judge").map(checkContentOf));
}

function checkContentOf(check: CheckSpec): unknown {
  if (check.family !== "judge") return check;
  return { ...check, judge: { ...check.judge, prompt: check.judge.prompt.sha256 } };
}

export function scorecardKeyHash(keys: Scorecard["keys"]): string {
  return hashCanonical(omit(keys, HASH_EXCLUDED_FIELDS.scorecardKey));
}

async function pinRef<T extends PromptRef | undefined>(ref: T, read: ReadPrompt): Promise<T> {
  if (ref === undefined) return ref;
  return { ...ref, sha256: sha256Hex(await read(ref.path)) };
}

/** Re-reads every prompt a variant references so its hash follows the file, not the stored digest. */
export async function pinVariantPrompts(variant: VariantSpec, read: ReadPrompt): Promise<VariantSpec> {
  const entries = await Promise.all(
    Object.entries(variant.steps).map(async ([id, step]): Promise<[string, StepSpec]> => {
      if (step.kind === "llm") return [id, { ...step, prompt: await pinRef(step.prompt, read) }];
      if (step.kind !== "agent") return [id, step];
      return [id, { ...step, prompt: await pinRef(step.prompt, read), systemPrompt: await pinRef(step.systemPrompt, read) }];
    }),
  );
  return { ...variant, steps: Object.fromEntries(entries) };
}

/** Re-reads judge and simulated-owner prompts, the suite-side counterpart of pinVariantPrompts. */
export async function pinSuitePrompts(suite: SuiteSpec, read: ReadPrompt): Promise<SuiteSpec> {
  const checks = await Promise.all(
    suite.checks.map(async (check) =>
      check.family === "judge" ? { ...check, judge: { ...check.judge, prompt: await pinRef(check.judge.prompt, read) } } : check,
    ),
  );
  const owner = suite.simulatedOwner;
  const simulatedOwner = owner?.kind === "persona" ? { ...owner, prompt: await pinRef(owner.prompt, read) } : owner;
  return { ...suite, checks, simulatedOwner };
}
