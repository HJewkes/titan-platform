import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ControlKind } from "../../review-pr/controls.js";
import { seededOrder, type ReviewCase } from "../review/cases.js";
import { REAL, NOT_REAL, citedLines } from "./review-fa.js";

/** One control in the shape `parseFaControls` reads. */
interface FaControlJson {
  key: string;
  expected: typeof REAL | typeof NOT_REAL;
  review: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  citedLines: string;
  diff: string;
}

/** Builds a case's bundle as `<dir>/{head,diff.patch}`; the caller deletes it. */
export type BuildBundle = (benchCase: ReviewCase, dir: string) => Promise<void>;

const WHAT_THE_PLANT_DOES: Record<ControlKind, string> = {
  "deleted-assertion": "an assertion was deleted here, so this test no longer checks the result it was written to check",
  "inverted-condition": "the condition on this line is inverted, so the branch runs in the opposite case from the one intended",
  "toothless-test": "the assertion on this line only checks that the value is defined, so the test passes whatever the value is",
};

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
const IMPORT_LINE = /^\s*import\s.+from\s/;

const verdict = (claim: string, path: string, line: number): string =>
  `Verdict: FIX_FIRST\n\nBlocking: ${path}:${line} - ${claim}`;

/** Head lines are 1-based; the diff names the added ones in its hunk headers. */
function addedLines(diff: string, path: string): Set<number> {
  const added = new Set<number>();
  let inFile = false;
  let line = 0;
  for (const text of diff.split("\n")) {
    if (text.startsWith("+++ ")) inFile = text === `+++ b/${path}`;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(text);
    if (hunk !== null) line = Number(hunk[1]);
    else if (inFile && text.startsWith("+") && !text.startsWith("+++")) added.add(line++);
    else if (inFile && text.startsWith(" ")) line++;
  }
  return added;
}

const changedPaths = (diff: string): string[] => [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1] ?? "");

interface Pick {
  path: string;
  line: number;
  claim: string;
}

/** The first unchanged comment or import line of a changed file, with a false claim about it. */
function fabricatedPick(diff: string, headLines: (path: string) => readonly string[] | undefined): Pick | undefined {
  for (const path of changedPaths(diff)) {
    const lines = headLines(path);
    if (lines === undefined) continue;
    const added = addedLines(diff, path);
    const index = lines.findIndex((text, at) => !added.has(at + 1) && (COMMENT_LINE.test(text) || IMPORT_LINE.test(text)));
    if (index < 0) continue;
    const claim = COMMENT_LINE.test(lines[index] ?? "")
      ? "this line dereferences a value that is never assigned, so it throws a TypeError at runtime"
      : "this import names a module that does not exist, so loading the file throws";
    return { path, line: index + 1, claim };
  }
  return undefined;
}

const readHead = (dir: string) => (path: string): string[] | undefined => {
  try {
    return readFileSync(join(dir, "head", path), "utf8").split("\n");
  } catch {
    return undefined;
  }
};

async function withBundle<T>(benchCase: ReviewCase, scratch: string, build: BuildBundle, use: (dir: string) => T): Promise<T | undefined> {
  const dir = mkdtempSync(join(scratch, "bundle-"));
  try {
    await build(benchCase, dir);
    return use(dir);
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function control(key: string, expected: FaControlJson["expected"], review: string, pick: Pick, dir: string): FaControlJson {
  const lines = readHead(dir)(pick.path) ?? [];
  const { path, line } = pick;
  const diff = readFileSync(join(dir, "diff.patch"), "utf8");
  return { key, expected, review, path, lineStart: line, lineEnd: line, citedLines: citedLines(lines, path, line, line), diff };
}

function realControl(benchCase: ReviewCase, scratch: string, build: BuildBundle): Promise<FaControlJson | undefined> {
  const { plant } = benchCase;
  if (plant === undefined) return Promise.resolve(undefined);
  const pick = { path: plant.path, line: plant.line, claim: WHAT_THE_PLANT_DOES[plant.kind] };
  return withBundle(benchCase, scratch, build, (dir) => control(`control-real:${benchCase.id}`, REAL, verdict(pick.claim, pick.path, pick.line), pick, dir));
}

function fabricatedControl(benchCase: ReviewCase, scratch: string, build: BuildBundle): Promise<FaControlJson | undefined> {
  return withBundle(benchCase, scratch, build, (dir) => {
    const pick = fabricatedPick(readFileSync(join(dir, "diff.patch"), "utf8"), readHead(dir));
    return pick && control(`control-not-real:${benchCase.id}`, NOT_REAL, verdict(pick.claim, pick.path, pick.line), pick, dir);
  });
}

async function firstN(cases: readonly ReviewCase[], count: number, make: (benchCase: ReviewCase) => Promise<FaControlJson | undefined>): Promise<FaControlJson[]> {
  const made: FaControlJson[] = [];
  for (const benchCase of cases) {
    if (made.length >= count) break;
    const one = await make(benchCase);
    if (one !== undefined) made.push(one);
  }
  return made;
}

/**
 * `count` controls, half real (a planted defect, described by its kind) and half not real (a false claim about an
 * unchanged comment or import line). The same seed over the same queue gives the same controls.
 */
export async function generateFaControls(queue: readonly ReviewCase[], count: number, seed: string, build: BuildBundle, scratchRoot: string): Promise<FaControlJson[]> {
  mkdirSync(scratchRoot, { recursive: true });
  const real = Math.ceil(count / 2);
  const planted = seededOrder(queue.filter((entry) => entry.caseType === "planted"), seed, "fa-real");
  const clean = seededOrder(queue.filter((entry) => entry.caseType === "clean"), seed, "fa-not-real");
  const realOnes = await firstN(planted, real, (entry) => realControl(entry, scratchRoot, build));
  const fabricated = await firstN(clean, count - real, (entry) => fabricatedControl(entry, scratchRoot, build));
  const made = [...realOnes, ...fabricated];
  if (made.length < count) throw new Error(`only ${made.length} of ${count} controls could be built from this queue`);
  return made;
}
