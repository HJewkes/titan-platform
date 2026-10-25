import type { Rule, Scope, SourceCode } from "eslint";
import type { CallExpression } from "estree";

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const CLOCK_CALLEE = /^(?:globalThis\.)?(?:Date\.now|performance\.now|process\.(?:hrtime(?:\.bigint)?|threadCpuUsage|cpuUsage))$/;
const COMPARISONS = new Set(["toBeLessThan", "toBeLessThanOrEqual", "toBeGreaterThan", "toBeGreaterThanOrEqual"]);
const BENCH = /bench/i;
const GATED_CALL = /\.(?:runIf|skipIf)\s*\([^)]*bench/i;

/** The comparison matcher an `expect(...)` call feeds, through any `.not`; null for any other use. */
function comparisonOf(call: Rule.Node): string | null {
  let member: Rule.Node | null = call.parent;
  if (member?.type === "MemberExpression" && !member.computed && member.property.type === "Identifier" && member.property.name === "not") member = member.parent;
  if (member?.type !== "MemberExpression" || member.computed || member.property.type !== "Identifier") return null;
  return COMPARISONS.has(member.property.name) && member.parent.type === "CallExpression" ? member.property.name : null;
}

function isExpect({ callee }: CallExpression): boolean {
  if (callee.type === "Identifier") return callee.name === "expect";
  return callee.type === "MemberExpression" && callee.object.type === "Identifier" && callee.object.name === "expect";
}

/** Whether a condition on the way up from `node` mentions a bench flag, so the assertion runs only under the bench. */
function benchGated(node: Rule.Node, source: SourceCode): boolean {
  for (let at: Rule.Node | null = node.parent; at; at = at.parent) {
    if (at.type === "IfStatement" || at.type === "ConditionalExpression") {
      if (BENCH.test(source.getText(at.test))) return true;
    } else if (at.type === "LogicalExpression") {
      if (BENCH.test(source.getText(at.left))) return true;
    } else if (at.type === "CallExpression" && GATED_CALL.test(source.getText(at.callee))) return true;
  }
  return false;
}

/** A node read by key, so one walker covers estree and typescript-eslint nodes alike. */
interface Flow {
  readonly type: string;
  readonly [key: string]: unknown;
}

const isFlow = (value: unknown): value is Flow => typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";

/** Nodes a value passes through whole, by the keys that carry it, so a property read on the result reads it there too. */
const KEEPERS: Readonly<Record<string, readonly string[]>> = {
  AwaitExpression: ["argument"],
  ChainExpression: ["expression"],
  TSAsExpression: ["expression"],
  TSNonNullExpression: ["expression"],
  TSSatisfiesExpression: ["expression"],
  ConditionalExpression: ["consequent", "alternate"],
  LogicalExpression: ["left", "right"],
  ArrowFunctionExpression: ["body"],
  FunctionExpression: ["body"],
};
/** Nodes that compute a new value from the whole of their operands, as arithmetic does; a call carries nothing by default. */
const MIXERS: Readonly<Record<string, readonly string[]>> = {
  BinaryExpression: ["left", "right"],
  UnaryExpression: ["argument"],
  ArrayExpression: ["elements"],
  SpreadElement: ["argument"],
};
/** Array methods whose result holds what the array or the callback's return held. */
const ARRAY_METHODS = new Set(["map", "flatMap", "filter", "reduce", "concat", "slice", "sort", "toSorted", "at", "find"]);
const FILLERS = new Set(["push", "unshift"]);
const MATH = /^(?:Math\.\w+|Number|BigInt)$/;
/** Deeper than any property path a clock reading is read through. */
const MAX_PATH = 8;
const FUNCTION_TYPES =new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function childNodes(node: Flow, keys: readonly string[]): Flow[] {
  return keys.flatMap((key) => [node[key]].flat()).filter(isFlow);
}

const keyOf = (node: unknown): string | null => {
  if (!isFlow(node)) return null;
  if (node.type === "Identifier") return String(node.name);
  return node.type === "Literal" ? String(node.value) : null;
};

/** `Date.now` for a callee that is a plain name path, null otherwise. */
function dottedName(node: unknown): string | null {
  if (!isFlow(node)) return null;
  if (node.type === "Identifier") return String(node.name);
  if (node.type !== "MemberExpression" || node.computed === true) return null;
  const [object, property] = [dottedName(node.object), keyOf(node.property)];
  return object === null || property === null ? null : `${object}.${property}`;
}

/** What a declared function or a block returns: each `return` argument outside nested functions. */
function returnsOf(node: unknown, source: SourceCode): Flow[] {
  if (!isFlow(node)) return [];
  if (node.type === "ReturnStatement") return childNodes(node, ["argument"]);
  return childNodes(node, source.visitorKeys[node.type] ?? []).flatMap((child) => (FUNCTION_TYPES.has(child.type) ? [] : returnsOf(child, source)));
}

/** The arguments of `name.push(...)` or `name.unshift(...)` at a read of `name`, which fill the array it names. */
function filledBy(reference: Scope.Reference): Flow[] {
  const member: unknown = Reflect.get(reference.identifier, "parent");
  if (!isFlow(member) || member.type !== "MemberExpression" || member.computed === true || !FILLERS.has(keyOf(member.property) ?? "")) return [];
  const call = member.parent;
  return isFlow(call) && call.type === "CallExpression" && call.callee === member ? childNodes(call, ["arguments"]) : [];
}

/** The values a variable holds: its initializer, later writes and pushes, or what a declared function returns. */
function sourcesOf(variable: Scope.Variable, source: SourceCode, path: Path): unknown[] {
  const writes = variable.references.flatMap((ref): unknown[] => (ref.isWrite() && ref.writeExpr ? [ref.writeExpr] : path.length === 0 ? filledBy(ref) : []));
  const functions = variable.defs.flatMap((def) => (def.type === "FunctionName" ? returnsOf(def.node, source) : []));
  return [...writes, ...functions];
}

/** The property names still to read from a value, outermost last: `a.b.c` reads `a` at ["b", "c"]. */
type Path = readonly string[];

interface Walk {
  readonly source: SourceCode;
  /** The variable each identifier in the file resolves to, by node. */
  readonly resolved: ReadonlyMap<unknown, Scope.Variable | null>;
  /** The paths each variable was already followed at. */
  readonly seen: Map<Scope.Variable, Set<string>>;
}

/**
 * Whether the value at `path` of `node` comes from a clock: a clock call, arithmetic on one, or a local name or function
 * whose value or return does. Names resolve through scope, so one test's `result` is not another's, and a property read
 * follows only that property. A call to any other function carries nothing: a server started with clock-stamped options
 * does not return a time.
 */
function readsClock(node: unknown, walk: Walk, path: Path): boolean {
  if (!isFlow(node)) return false;
  const follow = (keys: readonly string[], at: Path) => childNodes(node, keys).some((child) => readsClock(child, walk, at));
  switch (node.type) {
    case "CallExpression":
      return callReadsClock(node, walk, path);
    case "BlockStatement":
      return returnsOf(node, walk.source).some((child) => readsClock(child, walk, path));
    case "Identifier":
      return nameReadsClock(node, walk, path);
    case "MemberExpression":
      return follow(["object"], node.computed === true ? [] : [keyOf(node.property) ?? "", ...path]);
    case "ObjectExpression":
      return childNodes(node, ["properties"]).some((prop) => propertyReadsClock(prop, walk, path));
  }
  const keepers = KEEPERS[node.type];
  if (keepers) return follow(keepers, path);
  // A property of a sum or an array, such as its length, is no time.
  return path.length === 0 && follow(MIXERS[node.type] ?? [], []);
}

function propertyReadsClock(prop: Flow, walk: Walk, [key, ...rest]: Path): boolean {
  if (prop.type === "SpreadElement") return readsClock(prop.argument, walk, key === undefined ? [] : [key, ...rest]);
  if (key !== undefined && (prop.computed === true || keyOf(prop.key) !== key)) return false;
  return readsClock(prop.value, walk, rest);
}

function nameReadsClock(node: Flow, walk: Walk, path: Path): boolean {
  const variable = walk.resolved.get(node) ?? null;
  // A write such as `parent = parent.parentElement` reads the name one property deeper each time it is followed.
  if (variable === null || path.length > MAX_PATH) return false;
  const paths = walk.seen.get(variable) ?? new Set<string>();
  if (paths.has(path.join("."))) return false;
  walk.seen.set(variable, paths.add(path.join(".")));
  return sourcesOf(variable, walk.source, path).some((from) => readsClock(from, walk, path));
}

function callReadsClock(call: Flow, walk: Walk, path: Path): boolean {
  const name = dottedName(call.callee) ?? "";
  const anyOf = (nodes: Flow[]) => nodes.some((child) => readsClock(child, walk, []));
  if (CLOCK_CALLEE.test(name)) return true;
  if (MATH.test(name)) return anyOf(childNodes(call, ["arguments"]));
  const callee = call.callee;
  if (isFlow(callee) && callee.type === "MemberExpression" && ARRAY_METHODS.has(keyOf(callee.property) ?? "")) {
    return anyOf([...childNodes(callee, ["object"]), ...childNodes(call, ["arguments"])]);
  }
  return isFlow(callee) && callee.type === "Identifier" && readsClock(callee, walk, path);
}

/** Every identifier reference in the file and the variable it resolves to, null for a global. */
function resolvedNames(source: SourceCode): Map<unknown, Scope.Variable | null> {
  const resolved = new Map<unknown, Scope.Variable | null>();
  for (const scope of source.scopeManager.scopes) for (const ref of scope.references) resolved.set(ref.identifier, ref.resolved);
  return resolved;
}

export const noTestClockBudget: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow a test that compares elapsed time, or a ratio of times, with a limit outside a bench gate" },
    schema: [],
    messages: {
      clockBudget:
        "`{{matcher}}` compares a clock reading with a limit, which a loaded CI runner can miss. Assert counted work instead (test-kit `linearWork`, tool-guard `countWork`), or run the timing only under a bench env flag (TP-4262).",
    },
  },
  create(context) {
    if (!TEST_FILE.test(context.filename.replaceAll("\\", "/"))) return {};
    const source = context.sourceCode;
    let resolved: Map<unknown, Scope.Variable | null> | null = null;
    return {
      CallExpression(node) {
        const [actual] = node.arguments;
        if (!isExpect(node) || actual === undefined || actual.type === "SpreadElement") return;
        const matcher = comparisonOf(node);
        if (matcher === null || benchGated(node, source)) return;
        resolved ??= resolvedNames(source);
        if (!readsClock(actual, { source, resolved, seen: new Map() }, [])) return;
        context.report({ node, messageId: "clockBudget", data: { matcher } });
      },
    };
  },
};
