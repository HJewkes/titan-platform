import type { Node } from "web-tree-sitter";
import { forEachOwnNode, isFileRead, qualifiedCallee } from "./python-code-kinds.js";

/** The kinds of check one test function makes (TP-2170). A test can be several kinds at once. */
export interface TestKindFacts {
  snapshot: boolean;
  exactOutput: boolean;
  /** Its output assertions are all loose (`in`, `startswith`, length, shape, truthiness), and none is exact. */
  looseOutput: boolean;
  errorPath: boolean;
  property: boolean;
  roundtrip: boolean;
}

type AssertionKind = "snapshot" | "exact" | "roundtrip" | "loose" | "error" | "neutral";

/** pytest-regressions fixtures and syrupy's `snapshot`; a test that takes one compares against a stored file. */
const SNAPSHOT_FIXTURES = new Set([
  "snapshot", "data_regression", "file_regression", "num_regression", "dataframe_regression",
  "image_regression", "ndarrays_regression",
]);
/** `.code` only as an attribute (`excinfo.value.code`), so a bare local named `code` stays an ordinary value. */
const EXIT_STATUS = /(?:^|\.)(?:exit_code|returncode|status_code)$|\.code$/;
const EXACT_UNITTEST = /^assert(?:Equals?|ListEqual|DictEqual|TupleEqual|SetEqual|MultiLineEqual|SequenceEqual|CountEqual)$/;
const ERROR_CALLS = /^(?:pytest\.raises|.*\.assertRaises(?:Regex)?)$/;

/** pytest's collection rule: a `test*` function at module level or in a `Test*` class. */
export function isTestFunctionName(qualifiedName: string): boolean {
  const parts = qualifiedName.split(".");
  const own = parts.at(-1)!;
  if (!own.startsWith("test")) return false;
  return parts.length === 1 || (parts.length === 2 && parts[0]!.startsWith("Test"));
}

/** `exit_code != 0`, or equality with a non-zero exit code or an HTTP error status, asserts an error path. */
function exitStatusKind(op: string, other: Node): AssertionKind {
  const value = other.type === "integer" ? Number(other.text) : null;
  if (op === "!=" && value === 0) return "error";
  if (op === "==" && value !== null && value !== 0 && (value < 200 || value >= 400)) return "error";
  return "neutral";
}

/** The innermost first argument of a chain of at least two nested calls: `x` in `parse(dump(x))`. */
function roundtripSubject(node: Node): string | null {
  let depth = 0;
  let current = node;
  while (current.type === "call") {
    const first = current.childForFieldName("arguments")?.namedChildren[0];
    if (!first) return null;
    current = first;
    depth++;
  }
  return depth >= 2 ? current.text : null;
}

function isSnapshotSide(side: Node): boolean {
  if (side.type === "identifier" && side.text === "snapshot") return true;
  return side.type === "call" && side.childForFieldName("function")?.text === "snapshot";
}

function equalityKind(left: Node, right: Node): AssertionKind {
  if (isSnapshotSide(left) || isSnapshotSide(right)) return "snapshot";
  // Golden only when both sides are file reads: one side alone may be the output under test, checked exactly.
  if (isFileRead(left) && isFileRead(right)) return "snapshot";
  if (roundtripSubject(left) === right.text || roundtripSubject(right) === left.text) return "roundtrip";
  const sized = (n: Node) => /^len\(/.test(n.text) || /\.shape$/.test(n.text);
  return sized(left) || sized(right) ? "loose" : "exact";
}

function comparisonKind(cmp: Node): AssertionKind {
  const [left, right] = cmp.namedChildren;
  const op = cmp.children.find((c) => !c.isNamed)?.type ?? "";
  if (!left || !right || cmp.namedChildren.length !== 2) return "loose";
  if (EXIT_STATUS.test(left.text)) return exitStatusKind(op, right);
  if (EXIT_STATUS.test(right.text)) return exitStatusKind(op, left);
  return op === "==" ? equalityKind(left, right) : "loose";
}

function assertStatementKind(stmt: Node): AssertionKind {
  const expr = stmt.namedChildren[0];
  if (!expr) return "neutral";
  return expr.type === "comparison_operator" ? comparisonKind(expr) : "loose";
}

function unittestKind(method: string): AssertionKind {
  if (method.startsWith("assertRaises")) return "error";
  return EXACT_UNITTEST.test(method) ? "exact" : "loose";
}

function callKind(call: Node, imports: ReadonlyMap<string, string>): AssertionKind | null {
  const callee = qualifiedCallee(call, imports);
  if (ERROR_CALLS.test(callee)) return "error";
  if (/(?:^|\.)verify(?:_\w+)?$/.test(callee)) return "snapshot";
  const method = /^self\.(assert\w+)$/.exec(callee)?.[1];
  return method ? unittestKind(method) : null;
}

function hasGivenDecorator(def: Node): boolean {
  if (def.parent?.type !== "decorated_definition") return false;
  return def.parent.namedChildren.some((d) => d.type === "decorator" && /^@\s*(?:hypothesis\.)?given\b/.test(d.text));
}

function takesSnapshotFixture(def: Node): boolean {
  return (def.childForFieldName("parameters")?.namedChildren ?? []).some((p) => {
    const id = p.type === "identifier" ? p : p.descendantsOfType("identifier")[0];
    return id !== undefined && SNAPSHOT_FIXTURES.has(id.text);
  });
}

function assertionKinds(body: Node, imports: ReadonlyMap<string, string>): AssertionKind[] {
  const kinds: AssertionKind[] = [];
  forEachOwnNode(body, (node) => {
    if (node.type === "assert_statement") kinds.push(assertStatementKind(node));
    else if (node.type === "call") {
      const kind = callKind(node, imports);
      if (kind) kinds.push(kind);
    }
  });
  return kinds;
}

/** Classify one test function by the assertions in its own body and its decorators and fixtures. */
export function testKindFacts(def: Node, imports: ReadonlyMap<string, string>): TestKindFacts {
  const body = def.childForFieldName("body");
  const kinds = new Set(body ? assertionKinds(body, imports) : []);
  const snapshot = kinds.has("snapshot") || takesSnapshotFixture(def);
  const exactOutput = kinds.has("exact");
  const roundtrip = kinds.has("roundtrip");
  return {
    snapshot,
    exactOutput,
    looseOutput: kinds.has("loose") && !snapshot && !exactOutput && !roundtrip,
    errorPath: kinds.has("error"),
    property: hasGivenDecorator(def),
    roundtrip,
  };
}
