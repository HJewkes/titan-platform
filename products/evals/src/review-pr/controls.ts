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

type Rewrite = Omit<LineEdit, "index">;

function rewriteLine(kind: ControlKind, line: string): Rewrite | undefined {
  if (kind === "inverted-condition") {
    const match = CONDITION.exec(line);
    return match ? { replacement: `${match[1]}!(${match[2]})${match[3]}`, description: "the condition is inverted, so the branch runs in the opposite case" } : undefined;
  }
  if (!ASSERTION.test(line)) return undefined;
  if (kind === "deleted-assertion") return { replacement: null, description: "an assertion was deleted, so the test no longer checks this result" };
  const match = MATCHER.exec(line);
  return match ? { replacement: `${match[1]}.toBeDefined();`, description: "the assertion only checks the value is defined, so the test no longer bites" } : undefined;
}

const essence = (line: string) => line.trim().replace(/;$/, "").trimEnd();

/** A rewrite that leaves the line as it was would give the control a gold defect the tree never carries. */
function changesLine(original: string, rewrite: Rewrite): boolean {
  return rewrite.replacement === null || essence(rewrite.replacement) !== essence(original);
}

function canCarry(kind: ControlKind, path: string): boolean {
  const isTest = TEST_FILE.test(path);
  return kind === "inverted-condition" ? !isTest && SOURCE_FILE.test(path) : isTest;
}

function findEdit(kind: ControlKind, path: string, lines: readonly string[]): LineEdit | undefined {
  if (!canCarry(kind, path)) return undefined;
  for (const [index, line] of lines.entries()) {
    const rewrite = rewriteLine(kind, line);
    if (rewrite && changesLine(line, rewrite)) return { index, ...rewrite };
  }
  return undefined;
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
