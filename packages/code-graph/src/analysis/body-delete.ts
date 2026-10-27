import { createHash } from "node:crypto";
import {
  Node,
  Project,
  type ArrowFunction,
  type ConstructorDeclaration,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  type SourceFile,
} from "ts-morph";
import { symbolId } from "../extractors/symbol-id.js";

export const MAX_BODY_DELETES = 10;
/** fix-proof's MAX_MUTATION_EDIT: `replace`, the longer side, must fit under it. */
const MAX_EDIT = 400;
const EARLY_RETURN = " return undefined as never;";

/** A generated edit: fix-proof's Mutation with no declared kills, since it proves nothing about a named test. */
export interface HeadMutation {
  name: string;
  file: string;
  find: string;
  replace: string;
}

export interface BodyDeleteTarget {
  nodeId: string;
  file: string;
  symbol: string;
  lineStart: number;
  lineEnd: number;
  mutation: HeadMutation;
}

export type BodyDeleteSkip =
  | "uncovered"
  | "unchanged"
  | "expression-body"
  | "constructor"
  | "generator"
  | "overload-or-abstract"
  | "find-not-unique"
  | "find-over-cap"
  | "capped";

export interface BodyDeletePlan {
  targets: BodyDeleteTarget[];
  skipped: Array<{ nodeId: string; reason: BodyDeleteSkip }>;
}

export interface PlanBodyDeletesInput {
  /** Repo-relative path → head text, TS/TSX source only. */
  files: ReadonlyMap<string, string>;
  /** Path → head-side inclusive line ranges from `-U0` hunks. */
  changed: ReadonlyMap<string, readonly (readonly [number, number])[]>;
  /** Path → start lines of functions Istanbul saw run at least once. */
  covered: ReadonlyMap<string, ReadonlySet<number>>;
  max?: number;
  /** The head sha, so a rerun at the same head samples the same targets. */
  seed: string;
}

type FunctionLike = FunctionDeclaration | MethodDeclaration | ArrowFunction | FunctionExpression | ConstructorDeclaration;

interface Candidate {
  nodeId: string;
  symbol: string;
  node: FunctionLike;
  lineStart: number;
  lineEnd: number;
}

type Verdict = { target: BodyDeleteTarget } | { reason: BodyDeleteSkip };

function isFunctionLike(node: Node): node is FunctionLike {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node) ||
    Node.isConstructorDeclaration(node)
  );
}

function ownName(node: Node): string | undefined {
  if (Node.isConstructorDeclaration(node)) return "constructor";
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) || Node.isClassDeclaration(node)) {
    return node.getName();
  }
  const parent = node.getParent();
  const named = Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isClassExpression(node);
  if (named && parent !== undefined && (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent) || Node.isPropertyDeclaration(parent))) {
    return parent.getName();
  }
  return Node.isFunctionExpression(node) ? node.getName() : undefined;
}

function qualifiedName(node: FunctionLike): string {
  const scopes = node
    .getAncestors()
    .filter((ancestor) => isFunctionLike(ancestor) || Node.isClassDeclaration(ancestor) || Node.isClassExpression(ancestor))
    .map((ancestor) => ownName(ancestor) ?? `<anonymous@${ancestor.getStartLineNumber()}>`)
    .reverse();
  return [...scopes, ownName(node) ?? `<anonymous@${node.getStartLineNumber()}>`].join(".");
}

function candidatesOf(file: string, source: SourceFile): Candidate[] {
  const seen = new Set<string>();
  return source.getDescendants().filter(isFunctionLike).map((node) => {
    const lineStart = node.getStartLineNumber();
    let symbol = qualifiedName(node);
    if (seen.has(symbol)) symbol = `${symbol}@${lineStart}`;
    seen.add(symbol);
    return { nodeId: symbolId(file, symbol), symbol, node, lineStart, lineEnd: node.getEndLineNumber() };
  });
}

/** The block body an early return can go into, or why there is none. */
function blockBody(node: FunctionLike): Node | BodyDeleteSkip {
  if (Node.isConstructorDeclaration(node)) return "constructor";
  if (!Node.isArrowFunction(node) && node.isGenerator()) return "generator";
  const body = node.getBody();
  if (body === undefined) return "overload-or-abstract";
  return Node.isBlock(body) ? body : "expression-body";
}

function intersects(start: number, end: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([from, to]) => from <= end && to >= start);
}

function isCovered(candidate: Candidate, braceLine: number, starts: ReadonlySet<number> | undefined): boolean {
  if (starts === undefined) return false;
  for (let line = candidate.lineStart; line <= braceLine; line += 1) if (starts.has(line)) return true;
  return false;
}

// Overlapping matches count, as fix-proof's checkMutation counts them.
function occursOnce(text: string, find: string): boolean {
  const first = text.indexOf(find);
  return first !== -1 && text.indexOf(find, first + 1) === -1;
}

function lineStartBefore(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1;
}

/** Header text through the body's `{`, widened back a line at a time until it occurs once in the file. */
function uniqueFind(text: string, start: number, braceEnd: number): { find: string } | { reason: BodyDeleteSkip } {
  let from = start;
  for (;;) {
    const find = text.slice(from, braceEnd);
    if (find.length + EARLY_RETURN.length > MAX_EDIT) return { reason: "find-over-cap" };
    if (occursOnce(text, find)) return { find };
    if (from === 0) return { reason: "find-not-unique" };
    from = lineStartBefore(text, from === lineStartBefore(text, from) ? from - 1 : from);
  }
}

function judge(file: string, text: string, candidate: Candidate, input: PlanBodyDeletesInput): Verdict {
  if (!intersects(candidate.lineStart, candidate.lineEnd, input.changed.get(file) ?? [])) return { reason: "unchanged" };
  const body = blockBody(candidate.node);
  if (typeof body === "string") return { reason: body };
  if (!isCovered(candidate, body.getStartLineNumber(), input.covered.get(file))) return { reason: "uncovered" };
  const found = uniqueFind(text, candidate.node.getStart(), body.getStart() + 1);
  if ("reason" in found) return found;
  const { nodeId, symbol, lineStart, lineEnd } = candidate;
  const mutation = { name: `body-delete:${symbol}`, file, find: found.find, replace: found.find + EARLY_RETURN };
  return { target: { nodeId, file, symbol, lineStart, lineEnd, mutation } };
}

function seededSample(targets: BodyDeleteTarget[], max: number, seed: string): Set<BodyDeleteTarget> {
  const rank = (target: BodyDeleteTarget) => createHash("sha256").update(`${seed}\0${target.nodeId}`).digest("hex");
  const ranked = targets.map((target) => ({ target, key: rank(target) }));
  ranked.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return new Set(ranked.slice(0, max).map(({ target }) => target));
}

/**
 * One early-return mutant per changed, covered, block-bodied function in `files`; every other function is skipped with a
 * reason. Over `max`, a sample seeded by `seed` is kept and the rest are `capped`. Pure: nothing is read or written.
 */
export function planBodyDeletes(input: PlanBodyDeletesInput): BodyDeletePlan {
  const max = input.max ?? MAX_BODY_DELETES;
  if (!Number.isInteger(max) || max < 0) throw new RangeError(`max must be a non-negative integer, got ${max}`);
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const eligible: BodyDeleteTarget[] = [];
  const skipped: BodyDeletePlan["skipped"] = [];
  for (const [file, text] of input.files) {
    const source = project.createSourceFile(`/${file}`, text, { overwrite: true });
    for (const candidate of candidatesOf(file, source)) {
      const verdict = judge(file, text, candidate, input);
      if ("target" in verdict) eligible.push(verdict.target);
      else skipped.push({ nodeId: candidate.nodeId, reason: verdict.reason });
    }
  }
  const kept = eligible.length > max ? seededSample(eligible, max, input.seed) : new Set(eligible);
  for (const target of eligible) if (!kept.has(target)) skipped.push({ nodeId: target.nodeId, reason: "capped" });
  return { targets: eligible.filter((target) => kept.has(target)), skipped };
}
