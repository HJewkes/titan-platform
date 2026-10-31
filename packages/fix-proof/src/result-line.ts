import { isRecord } from "@titan-design/rpc-protocol/narrow";
import { TEST_CLASSES, VERDICTS, type Classification, type TestClass, type TestOutcome, type Verdict } from "./classify.js";
import { MUTANT_OUTCOMES, MUTANT_VERDICTS, type MutantResult, type MutantsResult } from "./mutant-classify.js";
import type { FixProofPlan } from "./plan.js";

export const RESULT_PREFIX = "fix-proof/v1 ";
export const RESULT_LINE_MAX_BYTES = 4096;
const MAX_ERROR_CHARS = 200;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** fix-proof-run.sh's shown_ref: a plain ref alphabet with `?` for anything else, or `<none>` for an empty ref. */
const SHOWN_REF = /^(?:[A-Za-z0-9._/+?-]+|<none>)$/;

export interface FixProofResult {
  head: string;
  mergeBase: string;
  verdict: Verdict;
  counts: Record<TestClass, number>;
  notCollected: string[];
  deletedTests: string[];
  configEdited: boolean;
  tests: TestOutcome[];
  /** True when format dropped entries to fit the 4 KB line. */
  truncated: boolean;
  error?: string;
  /**
   * The mutation check, present for a diff of test material alone that adds or changes a mutation spec, and as an error
   * beside an `error` verdict for a source diff whose spec has a kill naming no test at head.
   */
  mutants?: MutantsResult;
  /** The base branch the line judged, as fix-proof-run.sh shows a ref; a judge that predates it prints none. */
  base?: string;
  /** Only on a `refused` line: the default branch fix-proof runs against, which `base` is not. */
  defaultBranch?: string;
}

export type ParsedResultLine = { ok: true; result: FixProofResult } | { ok: false; error: string };

/**
 * Whether the mutation check proves a result its base-against-head run cannot. A test-only diff runs the same production
 * code on both sides, so it reads vacuous at best. It is proved when every changed test file has a spec of its own in the
 * diff, every declared mutation is killed, every selected test ran and passed at head, and no test was deleted or renamed
 * out of the tests. A line with no `uncovered` list comes from a judge that never checked coverage, so it proves nothing.
 */
export function provedByMutants(result: FixProofResult): boolean {
  const { counts, mutants } = result;
  const headPasses = counts["passes-on-base"] > 0 && counts["fails-on-head"] === 0 && counts["not-run"] === 0;
  const covered = mutants?.uncovered !== undefined && mutants.uncovered.length === 0 && result.deletedTests.length === 0;
  return result.verdict === "vacuous" && mutants?.verdict === "killed" && covered && headPasses;
}

// Spelled out so a new test class fails to compile here instead of leaving a count missing.
function countsBy(read: (name: TestClass) => number): Record<TestClass, number> {
  return {
    reproduces: read("reproduces"),
    "passes-on-base": read("passes-on-base"),
    "new-api": read("new-api"),
    "fails-on-head": read("fails-on-head"),
    "not-run": read("not-run"),
  };
}

/** Joins a plan and its classification into the result a runner prints for head. */
export function toResult(args: { head: string; mergeBase: string; plan: FixProofPlan; classification: Classification }): FixProofResult {
  const { classification, plan } = args;
  const counts = countsBy(() => 0);
  classification.tests.forEach((test) => (counts[test.class] += 1));
  const result: FixProofResult = {
    head: args.head,
    mergeBase: args.mergeBase,
    verdict: classification.verdict,
    counts,
    notCollected: classification.files.filter((file) => file.head === "not-collected").map((file) => file.file),
    deletedTests: [...plan.deletedTests],
    configEdited: plan.configEdited,
    tests: classification.tests.map((test) => ({ ...test })),
    truncated: false,
  };
  if (classification.error !== undefined) result.error = classification.error;
  return result;
}

function canonical(result: FixProofResult): FixProofResult {
  const out: FixProofResult = {
    head: result.head,
    mergeBase: result.mergeBase,
    verdict: result.verdict,
    counts: countsBy((name) => result.counts[name]),
    notCollected: [...result.notCollected],
    deletedTests: [...result.deletedTests],
    configEdited: result.configEdited,
    tests: result.tests.map((test) => ({ file: test.file, name: test.name, class: test.class })),
    truncated: result.truncated,
  };
  if (result.error !== undefined) out.error = result.error;
  if (result.mutants !== undefined) out.mutants = canonicalMutants(result.mutants);
  if (result.base !== undefined) out.base = result.base;
  if (result.defaultBranch !== undefined) out.defaultBranch = result.defaultBranch;
  return out;
}

function canonicalMutant(result: MutantResult): MutantResult {
  const out: MutantResult = { spec: result.spec, name: result.name, outcome: result.outcome };
  if (result.failed !== undefined) out.failed = [...result.failed];
  return out;
}

function canonicalMutants(mutants: MutantsResult): MutantsResult {
  const out: MutantsResult = { verdict: mutants.verdict, results: mutants.results.map(canonicalMutant) };
  if (mutants.uncovered !== undefined) out.uncovered = [...mutants.uncovered];
  if (mutants.error !== undefined) out.error = mutants.error;
  return out;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function encode(result: FixProofResult): string {
  return RESULT_PREFIX + JSON.stringify(canonical(result));
}

// Reproducing entries are the evidence the verdict rests on, so they are the last tests dropped.
function dropTest(tests: TestOutcome[]): void {
  for (let index = tests.length - 1; index >= 0; index -= 1) {
    if (tests[index]?.class !== "reproduces") {
      tests.splice(index, 1);
      return;
    }
  }
  tests.pop();
}

// Results that are not killed are what a not-killed verdict rests on, so killed results are dropped first.
function dropMutant(results: MutantResult[]): void {
  const killed = results.map((result) => result.outcome).lastIndexOf("killed");
  results.splice(killed === -1 ? results.length - 1 : killed, 1);
}

function shrinkMutants(mutants: MutantsResult | undefined): boolean {
  if (mutants === undefined) return false;
  if (mutants.results.length > 0) dropMutant(mutants.results);
  // One uncovered file is kept: it is what a not-killed verdict with every mutant killed rests on.
  else if (mutants.uncovered !== undefined && mutants.uncovered.length > 1) mutants.uncovered.pop();
  else if (mutants.error !== undefined && mutants.error.length > MAX_ERROR_CHARS) mutants.error = mutants.error.slice(0, MAX_ERROR_CHARS);
  else return false;
  return true;
}

function shrinkLists(result: FixProofResult): boolean {
  if (result.deletedTests.length > 0) result.deletedTests.pop();
  else if (result.notCollected.length > 0) result.notCollected.pop();
  else if (result.error !== undefined && result.error.length > MAX_ERROR_CHARS) result.error = result.error.slice(0, MAX_ERROR_CHARS);
  else return false;
  return true;
}

function shrink(result: FixProofResult): boolean {
  if (result.tests.length > 0) dropTest(result.tests);
  else if (!shrinkMutants(result.mutants) && !shrinkLists(result)) return false;
  result.truncated = true;
  return true;
}

/** Encodes one `fix-proof/v1 <json>` line of at most 4 KB, dropping list entries to fit; throws when the result would not parse back. */
export function formatResultLine(result: FixProofResult): string {
  const invalid = validate(result);
  if (invalid !== null) throw new Error(`invalid fix-proof result: ${invalid}`);
  const working = canonical(result);
  let line = encode(working);
  while (byteLength(line) > RESULT_LINE_MAX_BYTES) {
    if (!shrink(working)) throw new Error("fix-proof result does not fit in 4 KB");
    line = encode(working);
  }
  return line;
}

/** Decodes a result line, refusing anything over 4 KB, of another version, with unknown fields or with duplicate or reordered keys. */
export function parseResultLine(line: string): ParsedResultLine {
  if (byteLength(line) > RESULT_LINE_MAX_BYTES) return { ok: false, error: "result line exceeds 4 KB" };
  if (!line.startsWith(RESULT_PREFIX)) return { ok: false, error: "not a fix-proof/v1 line" };
  const json = line.slice(RESULT_PREFIX.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "result is not valid JSON" };
  }
  try {
    assertValidResult(parsed);
  } catch (error) {
    if (error instanceof InvalidResultError) return { ok: false, error: error.message };
    throw error;
  }
  const result = parsed;
  if (JSON.stringify(canonical(result)) !== json) return { ok: false, error: "result is not canonical: duplicate, reordered or padded keys" };
  return { ok: true, result };
}

type UnknownRecord = Record<string, unknown>;

class InvalidResultError extends Error {}

function assertValidResult(value: unknown): asserts value is FixProofResult {
  const invalid = validate(value);
  if (invalid !== null) throw new InvalidResultError(invalid);
}

function checkKeys(value: UnknownRecord, required: readonly string[], optional: readonly string[], at: string): string | null {
  const unknownKey = Object.keys(value).find((key) => !required.includes(key) && !optional.includes(key));
  if (unknownKey !== undefined) return `unknown field ${at}${unknownKey}`;
  const missing = required.find((key) => !(key in value));
  return missing === undefined ? null : `missing field ${at}${missing}`;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateCounts(value: unknown): string | null {
  if (!isRecord(value)) return "counts must be an object";
  const keys = checkKeys(value, TEST_CLASSES, [], "counts.");
  if (keys !== null) return keys;
  const bad = TEST_CLASSES.find((name) => {
    const count = value[name];
    return typeof count !== "number" || !Number.isSafeInteger(count) || count < 0;
  });
  return bad === undefined ? null : `counts.${bad} must be a non-negative integer`;
}

function validateTest(value: unknown): string | null {
  if (!isRecord(value)) return "tests entries must be objects";
  const keys = checkKeys(value, ["file", "name", "class"], [], "tests[].");
  if (keys !== null) return keys;
  if (typeof value.file !== "string" || typeof value.name !== "string") return "tests[].file and name must be strings";
  return (TEST_CLASSES as readonly unknown[]).includes(value.class) ? null : "tests[].class is unknown";
}

function validateMutant(value: unknown): string | null {
  if (!isRecord(value)) return "mutants.results entries must be objects";
  const keys = checkKeys(value, ["spec", "name", "outcome"], ["failed"], "mutants.results[].");
  if (keys !== null) return keys;
  if (typeof value.spec !== "string" || typeof value.name !== "string") return "mutants.results[].spec and name must be strings";
  if (!(MUTANT_OUTCOMES as readonly unknown[]).includes(value.outcome)) return "mutants.results[].outcome is unknown";
  return value.failed === undefined || isStringList(value.failed) ? null : "mutants.results[].failed must be a string array";
}

function validateMutants(value: unknown, truncated: unknown): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return "mutants must be an object";
  const keys = checkKeys(value, ["verdict", "results"], ["uncovered", "error"], "mutants.");
  if (keys !== null) return keys;
  if (!(MUTANT_VERDICTS as readonly unknown[]).includes(value.verdict)) return "mutants.verdict is unknown";
  if (value.error !== undefined && typeof value.error !== "string") return "mutants.error must be a string";
  if (value.uncovered !== undefined && !isStringList(value.uncovered)) return "mutants.uncovered must be a string array";
  if (value.verdict === "killed" && isStringList(value.uncovered) && value.uncovered.length > 0) return "mutants verdict killed with an uncovered test file";
  if (!Array.isArray(value.results)) return "mutants.results must be an array";
  const problem = value.results.map(validateMutant).find((error) => error !== null);
  if (problem !== undefined) return problem;
  if (value.verdict !== "killed") return null;
  if (!value.results.every((result) => isRecord(result) && result.outcome === "killed")) return "mutants verdict killed with a mutant not killed";
  return value.results.length === 0 && truncated !== true ? "mutants verdict killed with no mutant" : null;
}

const RESULT_KEYS = ["head", "mergeBase", "verdict", "counts", "notCollected", "deletedTests", "configEdited", "tests", "truncated"];

function validateScalars(value: UnknownRecord): string | null {
  if (typeof value.head !== "string" || !SHA.test(value.head)) return "head must be a full lowercase sha";
  if (typeof value.mergeBase !== "string" || !SHA.test(value.mergeBase)) return "mergeBase must be a full lowercase sha";
  if (!(VERDICTS as readonly unknown[]).includes(value.verdict)) return "verdict is unknown";
  if (typeof value.configEdited !== "boolean" || typeof value.truncated !== "boolean") return "configEdited and truncated must be booleans";
  if (value.error !== undefined && typeof value.error !== "string") return "error must be a string";
  if (!isStringList(value.notCollected) || !isStringList(value.deletedTests)) return "notCollected and deletedTests must be string arrays";
  return null;
}

const isShownRef = (value: unknown): boolean => typeof value === "string" && SHOWN_REF.test(value);

/** A refused line ran nothing, so it carries no count or test, and it names both refs so no reader parses its error text. */
function validateRefs(value: UnknownRecord): string | null {
  if (value.base !== undefined && !isShownRef(value.base)) return "base must be a branch name as fix-proof-run.sh shows one";
  if (value.verdict !== "refused") return value.defaultBranch === undefined ? null : "defaultBranch is set only on a refused line";
  if (value.base === undefined || !isShownRef(value.defaultBranch)) return "a refused line must name its base and the default branch";
  const { counts } = value;
  const counted = !isRecord(counts) || TEST_CLASSES.some((name) => counts[name] !== 0);
  return counted || !Array.isArray(value.tests) || value.tests.length > 0 ? "a refused line must have no count and no test" : null;
}

function validate(value: unknown): string | null {
  if (!isRecord(value)) return "result must be an object";
  const problem =
    checkKeys(value, RESULT_KEYS, ["error", "mutants", "base", "defaultBranch"], "") ??
    validateScalars(value) ??
    validateCounts(value.counts) ??
    validateMutants(value.mutants, value.truncated) ??
    validateRefs(value);
  if (problem !== null) return problem;
  if (value.verdict === "reproduced" && isRecord(value.counts) && value.counts.reproduces === 0) return "verdict reproduced with no reproducing test";
  if (!Array.isArray(value.tests)) return "tests must be an array";
  return value.tests.map(validateTest).find((error) => error !== null) ?? null;
}
