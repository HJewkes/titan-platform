/** The seeded defects a planted control carries: each is one line a reviewer should block on. */
export const CONTROL_KINDS = ["deleted-assertion", "inverted-condition", "toothless-test"] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

export interface PlantedDefect {
  kind: ControlKind;
  path: string;
  /** 1-based, in the head file: the deleted line, or the line rewritten in place. */
  line: number;
  description: string;
  /** The whole file after the mutation. */
  text: string;
}

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
/** A whole-line assertion, so deleting it leaves the test syntactically whole. */
const ASSERTION = /^\s*expect\(.*\)\.(?:not\.)?to[A-Z]\w*\(.*\);?\s*$/;
const CONDITION = /^(\s*(?:\}\s*else\s+)?if\s*\()(.+)(\)\s*\{\s*)$/;
const MATCHER = /^(\s*expect\(.*\))\.(?:not\.)?to[A-Z]\w*\(.*\);?\s*$/;

interface LineEdit {
  index: number;
  replacement: string | null;
  description: string;
}

function findEdit(kind: ControlKind, path: string, lines: readonly string[]): LineEdit | undefined {
  const isTest = TEST_FILE.test(path);
  if (kind === "inverted-condition") {
    if (isTest || !SOURCE_FILE.test(path)) return undefined;
    const index = lines.findIndex((line) => CONDITION.test(line));
    const match = CONDITION.exec(lines[index] ?? "");
    return match ? { index, replacement: `${match[1]}!(${match[2]})${match[3]}`, description: "the condition is inverted, so the branch runs in the opposite case" } : undefined;
  }
  if (!isTest) return undefined;
  const index = lines.findIndex((line) => ASSERTION.test(line));
  if (index < 0) return undefined;
  if (kind === "deleted-assertion") return { index, replacement: null, description: "an assertion was deleted, so the test no longer checks this result" };
  const match = MATCHER.exec(lines[index] ?? "");
  return match ? { index, replacement: `${match[1]}.toBeDefined();`, description: "the assertion only checks the value is defined, so the test no longer bites" } : undefined;
}

/** Plants `kind` at the first line of `text` that can carry it, or returns undefined when none can. */
export function plantDefect(kind: ControlKind, path: string, text: string): PlantedDefect | undefined {
  const lines = text.split("\n");
  const edit = findEdit(kind, path, lines);
  if (!edit) return undefined;
  const replacement = edit.replacement === null ? [] : [edit.replacement];
  const mutated = [...lines.slice(0, edit.index), ...replacement, ...lines.slice(edit.index + 1)];
  return { kind, path, line: edit.index + 1, description: edit.description, text: mutated.join("\n") };
}
