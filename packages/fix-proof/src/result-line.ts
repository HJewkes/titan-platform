import { TEST_CLASSES, VERDICTS, type Classification, type TestClass, type TestOutcome, type Verdict } from "./classify.js";
import type { FixProofPlan } from "./plan.js";

export const RESULT_PREFIX = "fix-proof/v1 ";
export const RESULT_LINE_MAX_BYTES = 4096;
const MAX_ERROR_CHARS = 200;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

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
}

export type ParsedResultLine = { ok: true; result: FixProofResult } | { ok: false; error: string };

/** Joins a plan and its classification into the result a runner prints for head. */
export function toResult(args: { head: string; mergeBase: string; plan: FixProofPlan; classification: Classification }): FixProofResult {
  const { classification, plan } = args;
  const counts = Object.fromEntries(TEST_CLASSES.map((name) => [name, 0])) as Record<TestClass, number>;
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
    counts: Object.fromEntries(TEST_CLASSES.map((name) => [name, result.counts[name]])) as Record<TestClass, number>,
    notCollected: [...result.notCollected],
    deletedTests: [...result.deletedTests],
    configEdited: result.configEdited,
    tests: result.tests.map((test) => ({ file: test.file, name: test.name, class: test.class })),
    truncated: result.truncated,
  };
  if (result.error !== undefined) out.error = result.error;
  return out;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function encode(result: FixProofResult): string {
  return RESULT_PREFIX + JSON.stringify(canonical(result));
}

function shrink(result: FixProofResult): boolean {
  if (result.tests.length > 0) result.tests.pop();
  else if (result.deletedTests.length > 0) result.deletedTests.pop();
  else if (result.notCollected.length > 0) result.notCollected.pop();
  else if (result.error !== undefined && result.error.length > MAX_ERROR_CHARS) result.error = result.error.slice(0, MAX_ERROR_CHARS);
  else return false;
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
  const invalid = validate(parsed);
  if (invalid !== null) return { ok: false, error: invalid };
  const result = parsed as FixProofResult;
  if (JSON.stringify(canonical(result)) !== json) return { ok: false, error: "result is not canonical: duplicate, reordered or padded keys" };
  return { ok: true, result };
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const bad = TEST_CLASSES.find((name) => !Number.isSafeInteger(value[name]) || (value[name] as number) < 0);
  return bad === undefined ? null : `counts.${bad} must be a non-negative integer`;
}

function validateTest(value: unknown): string | null {
  if (!isRecord(value)) return "tests entries must be objects";
  const keys = checkKeys(value, ["file", "name", "class"], [], "tests[].");
  if (keys !== null) return keys;
  if (typeof value.file !== "string" || typeof value.name !== "string") return "tests[].file and name must be strings";
  return (TEST_CLASSES as readonly unknown[]).includes(value.class) ? null : "tests[].class is unknown";
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

function validate(value: unknown): string | null {
  if (!isRecord(value)) return "result must be an object";
  const problem = checkKeys(value, RESULT_KEYS, ["error"], "") ?? validateScalars(value) ?? validateCounts(value.counts);
  if (problem !== null) return problem;
  if (value.verdict === "reproduced" && (value.counts as UnknownRecord).reproduces === 0) return "verdict reproduced with no reproducing test";
  if (!Array.isArray(value.tests)) return "tests must be an array";
  return value.tests.map(validateTest).find((error) => error !== null) ?? null;
}
