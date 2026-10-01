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

export function unitHash(unit: UnitSpec): string {
  const { id, version, input, output, artifacts, objective } = unit;
  return hashCanonical({ id, version, input, output, artifacts, objective });
}

export function caseHash(evalCase: EvalCase): string {
  const { input, fixture, expected, owner, provenance } = evalCase;
  return hashCanonical({ input, fixture: fixture && fixtureContent(fixture), expected, owner, labelVersion: provenance.labelVersion });
}

function fixtureContent(fixture: NonNullable<EvalCase["fixture"]>): unknown {
  if (fixture.kind === "repo") return { kind: fixture.kind, repo: fixture.repo, sha: fixture.sha };
  if (fixture.kind === "bundle") return { kind: fixture.kind, sha256: fixture.sha256 };
  return { kind: fixture.kind, treeSha256: fixture.treeSha256 };
}

/** Covers code and content, never locations: a moved prompt or skill keeps its hash. */
export function variantHash(variant: VariantSpec): string {
  const { topology, steps } = variant;
  const stepContent = Object.fromEntries(Object.entries(steps).map(([id, step]) => [id, stepContentOf(step)]));
  return hashCanonical({ topology: { export: topology.export, sourceSha256: topology.sourceSha256 }, steps: stepContent });
}

function stepContentOf(step: StepSpec): unknown {
  if (step.kind === "llm") return { ...step, prompt: step.prompt.sha256 };
  if (step.kind !== "agent") return step;
  return {
    ...step,
    prompt: step.prompt.sha256,
    systemPrompt: step.systemPrompt?.sha256,
    skills: step.skills.map(({ name, treeSha256 }) => ({ name, treeSha256 })),
  };
}

export function suiteHash(suite: SuiteSpec): string {
  const { cases, checks, simulatedOwner, trials } = suite;
  const owner = simulatedOwner?.kind === "persona" ? { ...simulatedOwner, prompt: simulatedOwner.prompt.sha256 } : simulatedOwner;
  return hashCanonical({ cases: [...cases].sort(), checks: checks.map(checkContentOf), simulatedOwner: owner, trials });
}

export function judgesHash(suite: SuiteSpec): string {
  return hashCanonical(suite.checks.filter((check) => check.family === "judge").map(checkContentOf));
}

function checkContentOf(check: CheckSpec): unknown {
  if (check.family !== "judge") return check;
  return { ...check, judge: { ...check.judge, prompt: check.judge.prompt.sha256 } };
}

/** The environment fingerprint is recorded beside the key, never inside it, so it warns rather than splits. */
export function scorecardKeyHash(keys: Scorecard["keys"]): string {
  const { unit, variant, suite, judges } = keys;
  return hashCanonical({ unit, variant, suite, judges });
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
