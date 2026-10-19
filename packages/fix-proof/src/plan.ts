import { CHANGESET_GLOB, CONFIG_PATH, isHarnessPath, MUTATION_SPEC_GLOB, parseFixProofConfig, type FixProofConfig } from "./config.js";
import { compileGlobs } from "./glob.js";
import { normalizeRelative } from "./paths.js";

export interface PlanInput {
  /** Output of `git diff -M --name-status <mergeBase> <head>`. */
  nameStatus: string;
  /** `.github/fix-proof.json` at the merge base; null or absent when the file does not exist there. */
  baseConfig?: string | null;
  /** The same file at head, used only to tell the reviewer the PR edited it. */
  headConfig?: string | null;
}

export interface FixProofPlan {
  /** Head paths of added or changed tests, to check out over the merge base and run. */
  tests: string[];
  /** Added or changed support files matching the carry globs. */
  carried: string[];
  /** Tests the PR deletes: never run, named to the reviewer. */
  deletedTests: string[];
  /** Old paths of partially renamed tests, removed from the overlay. */
  overlayRemovals: string[];
  /** Added or changed mutation specs, read at head by the mutants check. */
  mutations: string[];
  /**
   * Every changed or deleted path, both sides of a rename, that is a harness path or is not a test, a carried file, a
   * mutation spec or a changeset. Empty means the diff is test-only.
   */
  source: string[];
  config: FixProofConfig;
  configEdited: boolean;
}

export type PlanResult = { ok: true; plan: FixProofPlan } | { ok: false; error: string };

interface DiffEntry {
  status: string;
  score: number | null;
  path: string;
  oldPath: string | null;
}

const STATUS = /^(?:([AMDT])|([RC])(\d{1,3}))$/;

function parsePath(raw: string | undefined, line: string): string {
  if (raw === undefined || raw.startsWith('"')) throw new Error(`unsupported path in diff line: ${line}`);
  const path = normalizeRelative(raw);
  if (path === null) throw new Error(`unsafe path in diff line: ${line}`);
  return path;
}

function parseLine(line: string): DiffEntry {
  const [code = "", ...paths] = line.split("\t");
  const match = STATUS.exec(code);
  if (!match) throw new Error(`unsupported diff status: ${line}`);
  const pair = match[2] !== undefined;
  if (paths.length !== (pair ? 2 : 1)) throw new Error(`malformed diff line: ${line}`);
  const score = pair ? Number(match[3]) : null;
  if (score !== null && score > 100) throw new Error(`malformed similarity score: ${line}`);
  const status = match[1] ?? match[2] ?? "";
  if (!pair) return { status, score, path: parsePath(paths[0], line), oldPath: null };
  return { status, score, path: parsePath(paths[1], line), oldPath: parsePath(paths[0], line) };
}

function parseNameStatus(text: string): DiffEntry[] {
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map(parseLine);
}

interface Sorter {
  isTest: (path: string) => boolean;
  isCarry: (path: string) => boolean;
  isRuntime: (path: string) => boolean;
  isSpec: (path: string) => boolean;
  isChangeset: (path: string) => boolean;
  add: (bucket: keyof Buckets, path: string) => void;
}

interface Buckets {
  tests: Set<string>;
  carried: Set<string>;
  deletedTests: Set<string>;
  overlayRemovals: Set<string>;
  mutations: Set<string>;
  source: Set<string>;
}

function addSupport(sorter: Sorter, path: string): void {
  if (sorter.isSpec(path)) sorter.add("mutations", path);
  else if (sorter.isCarry(path)) sorter.add("carried", path);
}

function addChanged(sorter: Sorter, path: string): void {
  if (sorter.isTest(path)) sorter.add("tests", path);
  else addSupport(sorter, path);
}

function isTestOnlyPath(sorter: Sorter, path: string): boolean {
  if (isHarnessPath(path) || sorter.isRuntime(path)) return false;
  return sorter.isTest(path) || sorter.isCarry(path) || sorter.isSpec(path) || sorter.isChangeset(path);
}

// A copy leaves its old path untouched, so only a rename's old path counts as changed.
function addSource(sorter: Sorter, entry: DiffEntry): void {
  const paths = entry.status === "R" && entry.oldPath !== null ? [entry.oldPath, entry.path] : [entry.path];
  paths.filter((path) => !isTestOnlyPath(sorter, path)).forEach((path) => sorter.add("source", path));
}

function sortRename(sorter: Sorter, entry: DiffEntry & { oldPath: string }): void {
  const oldIsTest = sorter.isTest(entry.oldPath);
  if (!sorter.isTest(entry.path)) {
    if (oldIsTest) sorter.add("deletedTests", entry.oldPath);
    addSupport(sorter, entry.path);
    return;
  }
  if (entry.score === 100) return;
  sorter.add("tests", entry.path);
  if (oldIsTest) sorter.add("overlayRemovals", entry.oldPath);
}

function sortEntry(sorter: Sorter, entry: DiffEntry): void {
  addSource(sorter, entry);
  if (entry.status === "D") {
    if (sorter.isTest(entry.path)) sorter.add("deletedTests", entry.path);
  } else if (entry.status === "R" && entry.oldPath !== null) {
    sortRename(sorter, { ...entry, oldPath: entry.oldPath });
  } else {
    addChanged(sorter, entry.path);
  }
}

function buildPlan(entries: DiffEntry[], config: FixProofConfig, configEdited: boolean): FixProofPlan {
  const buckets: Buckets = {
    tests: new Set(),
    carried: new Set(),
    deletedTests: new Set(),
    overlayRemovals: new Set(),
    mutations: new Set(),
    source: new Set(),
  };
  const sorter: Sorter = {
    isTest: compileGlobs(config.tests),
    isCarry: compileGlobs(config.carry),
    isRuntime: compileGlobs(config.runtime),
    isSpec: compileGlobs([MUTATION_SPEC_GLOB]),
    isChangeset: compileGlobs([CHANGESET_GLOB]),
    add: (bucket, path) => buckets[bucket].add(path),
  };
  entries.forEach((entry) => sortEntry(sorter, entry));
  const sorted = (set: Set<string>) => [...set].sort();
  return {
    tests: sorted(buckets.tests),
    carried: sorted(buckets.carried),
    deletedTests: sorted(buckets.deletedTests),
    overlayRemovals: sorted(buckets.overlayRemovals),
    mutations: sorted(buckets.mutations),
    source: sorted(buckets.source),
    config,
    configEdited,
  };
}

function touchesConfig(entries: DiffEntry[]): boolean {
  return entries.some((entry) => entry.path === CONFIG_PATH || entry.oldPath === CONFIG_PATH);
}

// vitest would read a path that starts with a dash as a flag, so such a test makes the plan an error instead.
function rejectDashedTests(plan: FixProofPlan): PlanResult {
  const unsafe = plan.tests.find((test) => test.startsWith("-"));
  return unsafe === undefined ? { ok: true, plan } : { ok: false, error: `unsafe test path: ${unsafe}` };
}

/**
 * True when the diff touches only tests, carried files, mutation specs and changesets, none of them harness or runtime
 * paths. It ignores deleted tests and an empty `tests`; `testOnlyReading` refuses those too.
 */
export function testOnlyOf(plan: Pick<FixProofPlan, "source">): boolean {
  return plan.source.length === 0;
}

export type TestOnlyReading =
  | { testOnly: true }
  | { testOnly: false; reason: "source"; paths: string[] }
  | { testOnly: false; reason: "deletes-tests"; paths: string[] }
  | { testOnly: false; reason: "no-tests" };

/**
 * Whether a diff is test-only, and if not why: it changes source (runtime paths included), it deletes a test (a rename
 * out of the tests counts), or it adds or changes no test at all (a changeset- or fixture-only diff).
 */
export function testOnlyReading(plan: Pick<FixProofPlan, "source" | "tests" | "deletedTests">): TestOnlyReading {
  if (plan.source.length > 0) return { testOnly: false, reason: "source", paths: [...plan.source] };
  if (plan.deletedTests.length > 0) return { testOnly: false, reason: "deletes-tests", paths: [...plan.deletedTests] };
  if (plan.tests.length === 0) return { testOnly: false, reason: "no-tests" };
  return { testOnly: true };
}

/** Splits a merge-base-to-head diff into tests to run, carried support files, deleted tests, mutation specs and source, using globs from the base config only. */
export function planFixProof(input: PlanInput): PlanResult {
  const parsed = parseFixProofConfig(input.baseConfig);
  if (!parsed.ok) return parsed;
  let entries: DiffEntry[];
  try {
    entries = parseNameStatus(input.nameStatus);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const headDiffers = input.headConfig !== undefined && (input.headConfig ?? null) !== (input.baseConfig ?? null);
  return rejectDashedTests(buildPlan(entries, parsed.config, headDiffers || touchesConfig(entries)));
}
