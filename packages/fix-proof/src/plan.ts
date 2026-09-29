import { CONFIG_PATH, parseFixProofConfig, type FixProofConfig } from "./config.js";
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
  add: (bucket: keyof Buckets, path: string) => void;
}

interface Buckets {
  tests: Set<string>;
  carried: Set<string>;
  deletedTests: Set<string>;
  overlayRemovals: Set<string>;
}

function addChanged(sorter: Sorter, path: string): void {
  if (sorter.isTest(path)) sorter.add("tests", path);
  else if (sorter.isCarry(path)) sorter.add("carried", path);
}

function sortRename(sorter: Sorter, entry: DiffEntry & { oldPath: string }): void {
  const oldIsTest = sorter.isTest(entry.oldPath);
  if (!sorter.isTest(entry.path)) {
    if (oldIsTest) sorter.add("deletedTests", entry.oldPath);
    if (sorter.isCarry(entry.path)) sorter.add("carried", entry.path);
    return;
  }
  if (entry.score === 100) return;
  sorter.add("tests", entry.path);
  if (oldIsTest) sorter.add("overlayRemovals", entry.oldPath);
}

function sortEntry(sorter: Sorter, entry: DiffEntry): void {
  if (entry.status === "D") {
    if (sorter.isTest(entry.path)) sorter.add("deletedTests", entry.path);
  } else if (entry.status === "R" && entry.oldPath !== null) {
    sortRename(sorter, { ...entry, oldPath: entry.oldPath });
  } else {
    addChanged(sorter, entry.path);
  }
}

function buildPlan(entries: DiffEntry[], config: FixProofConfig, configEdited: boolean): FixProofPlan {
  const buckets: Buckets = { tests: new Set(), carried: new Set(), deletedTests: new Set(), overlayRemovals: new Set() };
  const sorter: Sorter = {
    isTest: compileGlobs(config.tests),
    isCarry: compileGlobs(config.carry),
    add: (bucket, path) => buckets[bucket].add(path),
  };
  entries.forEach((entry) => sortEntry(sorter, entry));
  const sorted = (set: Set<string>) => [...set].sort();
  return {
    tests: sorted(buckets.tests),
    carried: sorted(buckets.carried),
    deletedTests: sorted(buckets.deletedTests),
    overlayRemovals: sorted(buckets.overlayRemovals),
    config,
    configEdited,
  };
}

function touchesConfig(entries: DiffEntry[]): boolean {
  return entries.some((entry) => entry.path === CONFIG_PATH || entry.oldPath === CONFIG_PATH);
}

/** Splits a merge-base-to-head diff into tests to run, carried support files and deleted tests, using globs from the base config only. */
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
  return { ok: true, plan: buildPlan(entries, parsed.config, headDiffers || touchesConfig(entries)) };
}
