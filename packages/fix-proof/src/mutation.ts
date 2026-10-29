import { CHANGESET_GLOB, isHarnessPath, MUTATION_SPEC_GLOB, type FixProofConfig } from "./config.js";
import { compileGlobs } from "./glob.js";
import { normalizeRelative } from "./paths.js";

export const MAX_MUTATIONS = 5;
export const MAX_MUTATION_NAME = 80;
export const MAX_MUTATION_EDIT = 400;
export const MAX_KILLS = 20;
/** Five mutations at their field caps fit well under this; anything larger is not a spec a person wrote. */
export const MAX_SPEC_BYTES = 32 * 1024;

/** One exact edit to a non-test file at the merge base, and the full vitest names of the tests it must fail. */
export interface Mutation {
  name: string;
  file: string;
  find: string;
  replace: string;
  kills: string[];
}

/** A generated edit: a Mutation with no declared kills, since it proves nothing about a named test. */
export type HeadMutation = Omit<Mutation, "kills">;

export interface MutationSpec {
  v: 1;
  mutations: Mutation[];
}

export type MutationSpecResult = { ok: true; spec: MutationSpec } | { ok: false; error: string };
export type MutationCheck = { ok: true } | { ok: false; error: string };

const SPEC_KEYS = new Set(["v", "mutations"]);
const MUTATION_KEYS = new Set(["name", "file", "find", "replace", "kills"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, what: string, keys: ReadonlySet<string>): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${what} must be a JSON object`);
  const unknownKey = Object.keys(value).find((key) => !keys.has(key));
  if (unknownKey !== undefined) throw new Error(`${what}: unknown key ${unknownKey}`);
  return value;
}

function readText(value: unknown, what: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value === "")) throw new Error(`${what} must be a non-empty string`);
  if (value.length > max) throw new Error(`${what} is over ${max} characters`);
  return value;
}

function readFile(value: unknown, what: string): string {
  const file = readText(value, what, MAX_MUTATION_EDIT);
  if (normalizeRelative(file) !== file) throw new Error(`${what} must be a normalized repo-relative path`);
  return file;
}

function readKills(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${what} must be a non-empty array`);
  if (value.length > MAX_KILLS) throw new Error(`${what} names more than ${MAX_KILLS} tests`);
  const kills = value.map((name, index) => readText(name, `${what}[${index}]`, MAX_MUTATION_EDIT));
  if (new Set(kills).size !== kills.length) throw new Error(`${what} names a test twice`);
  return kills;
}

function readMutation(value: unknown, index: number): Mutation {
  const what = `mutations[${index}]`;
  const record = asRecord(value, what, MUTATION_KEYS);
  const mutation: Mutation = {
    name: readText(record.name, `${what}.name`, MAX_MUTATION_NAME),
    file: readFile(record.file, `${what}.file`),
    find: readText(record.find, `${what}.find`, MAX_MUTATION_EDIT),
    replace: readText(record.replace, `${what}.replace`, MAX_MUTATION_EDIT, true),
    kills: readKills(record.kills, `${what}.kills`),
  };
  if (mutation.find === mutation.replace) throw new Error(`${what}: find and replace are the same`);
  return mutation;
}

function readSpec(raw: unknown): MutationSpec {
  const record = asRecord(raw, "spec", SPEC_KEYS);
  if (record.v !== 1) throw new Error("spec.v must be 1");
  const list = record.mutations;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_MUTATIONS) {
    throw new Error(`spec.mutations must hold 1 to ${MAX_MUTATIONS} mutations`);
  }
  const mutations = list.map(readMutation);
  const duplicate = mutations.find((mutation, index) => mutations.findIndex((other) => other.name === mutation.name) !== index);
  if (duplicate !== undefined) throw new Error(`mutation name ${duplicate.name} is used twice`);
  return { v: 1, mutations };
}

/** Parses a `*.mutations.json` spec strictly: unknown keys, over-long fields and empty or duplicate kills are refused. */
export function parseMutationSpec(text: string): MutationSpecResult {
  if (Buffer.byteLength(text, "utf8") > MAX_SPEC_BYTES) return { ok: false, error: `mutation spec is over ${MAX_SPEC_BYTES} bytes` };
  try {
    return { ok: true, spec: readSpec(JSON.parse(text)) };
  } catch (error) {
    return { ok: false, error: `mutation spec: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// Overlapping matches count, so a find of "aa" in "aaa" is two occurrences, not one.
function occurrences(text: string, find: string): number {
  let count = 0;
  for (let at = text.indexOf(find); at !== -1 && count < 2; at = text.indexOf(find, at + 1)) count += 1;
  return count;
}

function targetRefusal(file: string, config: FixProofConfig): string | undefined {
  if (isHarnessPath(file)) return "is a fix-proof harness path";
  if (compileGlobs(config.tests)(file)) return "is a test";
  if (compileGlobs(config.carry)(file)) return "is a carried test-support file";
  if (compileGlobs([MUTATION_SPEC_GLOB, CHANGESET_GLOB])(file)) return "is a mutation spec or changeset";
  return undefined;
}

/**
 * Whether one mutation can run against the merge base: its file must be code under test, not a test, carried file, spec or
 * harness path, and must exist there (`baseText` null means it does not) with `find` occurring exactly once. `at` names
 * the commit `baseText` came from in the error, for a caller that checks against another one.
 */
export function checkMutation(mutation: HeadMutation, baseText: string | null, config: FixProofConfig, at = "the merge base"): MutationCheck {
  const refused = targetRefusal(mutation.file, config);
  if (refused !== undefined) return { ok: false, error: `mutation ${mutation.name}: ${mutation.file} ${refused}` };
  if (baseText === null) return { ok: false, error: `mutation ${mutation.name}: ${mutation.file} does not exist at ${at}` };
  const count = occurrences(baseText, mutation.find);
  if (count !== 1) {
    const found = count === 0 ? "does not occur" : "occurs more than once";
    return { ok: false, error: `mutation ${mutation.name}: find ${found} in ${mutation.file} at ${at}` };
  }
  return { ok: true };
}
