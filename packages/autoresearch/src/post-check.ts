import { banOn, matchesAny, paramCode, type Bounds, type ClassBounds } from "./bounds.js";
import type { DiffFile } from "./diff.js";
import type { DiffSize, Idea } from "./schemas.js";

export interface CheckRow {
  name: string;
  ok: boolean;
  code?: string;
}

export interface PostCheckInput {
  idea: Pick<Idea, "class">;
  diff: readonly DiffFile[];
  bounds: Bounds;
  /** The target's frozen globs: the evaluator and everything it reads. */
  frozen: readonly string[];
  /** The run's case names; the `seedNames` ban says where a host reads them from. */
  caseNames: readonly string[];
  /** `changedParams` over the class's params file, base against head. */
  paramValues?: Record<string, unknown>;
}

export interface PostCheck {
  code?: string;
  checks: CheckRow[];
  size: DiffSize;
}

const DEFAULT_ALLOWED_LITERALS = [0, 1, 2, -1];
const NUMERIC_LITERAL = /(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g;

const touched = (diff: readonly DiffFile[]) => diff.flatMap((file) => (file.from ? [file.path, file.from] : [file.path]));
const isTest = (spec: ClassBounds, path: string) => matchesAny(path, spec.tests);
/** A rename puts a file at a path that did not exist, so the new-file ban covers it too. */
const isNew = (file: DiffFile) => file.status === "A" || file.status === "R";

function noTest({ bounds, idea, diff }: PostCheckInput, spec: ClassBounds): string | undefined {
  if (!bounds.test.required || bounds.test.exceptClasses.includes(idea.class)) return undefined;
  return touched(diff).some((path) => isTest(spec, path)) ? undefined : "no-test";
}

function allowedLiterals(bounds: Bounds): number[] {
  const ban = bounds.banned.literalsOutsideConfig;
  return typeof ban === "object" && ban.allowed ? ban.allowed : DEFAULT_ALLOWED_LITERALS;
}

/** Source lines only: a test may name any number, and a params class's file is checked by range instead. */
function strayLiteral({ bounds, diff }: PostCheckInput, spec: ClassBounds): string | undefined {
  if (!banOn(bounds.banned.literalsOutsideConfig)) return undefined;
  const allowed = new Set(allowedLiterals(bounds));
  const source = diff.filter((file) => !isTest(spec, file.path) && !(spec.params && matchesAny(file.path, spec.paths)));
  const stray = source.some((file) => file.added.some((line) => [...line.matchAll(NUMERIC_LITERAL)].some(([literal]) => !allowed.has(Number(literal)))));
  return stray ? "stray-literal" : undefined;
}

type Check = (input: PostCheckInput, spec: ClassBounds) => string | undefined;

/** `oneClassPerIdea` needs no check of its own: an idea has one class, so `outside-class` enforces it. */
const CHECKS: [string, Check][] = [
  ["frozen-touch", ({ bounds, diff, frozen }) => (banOn(bounds.banned.frozenTouch) && touched(diff).some((path) => matchesAny(path, frozen)) ? "frozen-touch" : undefined)],
  ["outside-class", ({ diff }, spec) => (touched(diff).some((path) => !matchesAny(path, [...spec.paths, ...spec.tests])) ? "outside-class" : undefined)],
  ["new-file", ({ bounds, diff }, spec) => (banOn(bounds.banned.newFiles) && diff.some((file) => isNew(file) && !isTest(spec, file.path)) ? "new-file-outside-tests" : undefined)],
  ["test-required", noTest],
  ["case-name", ({ diff, caseNames }) => (diff.some((file) => file.added.some((line) => caseNames.some((name) => name !== "" && line.includes(name)))) ? "case-name" : undefined)],
  ["stray-literal", strayLiteral],
  ["params", ({ paramValues }, spec) => (paramValues ? paramCode(spec, paramValues) : undefined)],
];

function diffSize(diff: readonly DiffFile[], spec: ClassBounds | undefined): DiffSize {
  const lines = (files: readonly DiffFile[]) => files.reduce((total, file) => total + file.added.length + file.removed, 0);
  const test = (file: DiffFile) => spec !== undefined && isTest(spec, file.path);
  const source = diff.filter((file) => !test(file));
  return { files: diff.length, lines: lines(diff), srcFiles: source.length, srcLines: lines(source), testLines: lines(diff.filter(test)) };
}

/** `ar-bounds-post` (L0) over a real diff: every check runs and is recorded, and the first failure is the code. */
export function postCheck(input: PostCheckInput): PostCheck {
  const spec = input.bounds.classes[input.idea.class];
  const size = diffSize(input.diff, spec);
  if (!spec) return { code: "unknown-class", checks: [{ name: "class", ok: false, code: "unknown-class" }], size };
  const checks = CHECKS.map(([name, check]): CheckRow => {
    const code = check(input, spec);
    return code ? { name, ok: false, code } : { name, ok: true };
  });
  return { code: checks.find((row) => !row.ok)?.code, checks, size };
}

function flatten(value: unknown, prefix = "", into: Record<string, unknown> = {}): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) into[prefix] = value;
  else for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, into);
  return into;
}

/** Dotted keys whose value changed, mapped to the new value; a removed key maps to `null`. */
export function changedParams(beforeJson: string, afterJson: string): Record<string, unknown> {
  const [before, after] = [flatten(JSON.parse(beforeJson)), flatten(JSON.parse(afterJson))];
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) if (JSON.stringify(before[key]) !== JSON.stringify(value)) changed[key] = value;
  for (const key of Object.keys(before)) if (!(key in after)) changed[key] = null;
  return changed;
}

function expandBraces(glob: string): string[] {
  const match = /\{([^{}]*)\}/.exec(glob);
  if (!match) return [glob];
  const [head, tail] = [glob.slice(0, match.index), glob.slice(match.index + match[0].length)];
  return match[1]!.split(",").flatMap((alternative) => expandBraces(head + alternative + tail));
}

/**
 * Class globs an idea could use to edit a frozen path. With no file list only wildcard-free globs are
 * tested; a host with `git ls-files` passes it so glob classes are tested file by file.
 */
export function frozenOverlap(bounds: Bounds, frozen: readonly string[], files?: readonly string[]): string[] {
  const globs = [...new Set(Object.values(bounds.classes).flatMap((spec) => [...spec.paths, ...spec.tests]))];
  const literalHit = (glob: string) => expandBraces(glob).some((path) => !/[*?]/.test(path) && matchesAny(path, frozen));
  const fileHit = (glob: string) => files!.some((path) => matchesAny(path, [glob]) && matchesAny(path, frozen));
  return globs.filter((glob) => (files ? fileHit(glob) : literalHit(glob)));
}
