import type { Rule } from "eslint";
import type { CallExpression } from "estree";

const STEP_OPS = new Set(["dispatch", "seed", "assisted", "authorize"]);
const STEP_WRAPPERS = new Set(["step", "codeStep"]);
const LOOP_STATEMENTS = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const LOOP_CALLBACKS = new Set(["map", "forEach", "flatMap", "reduce", "reduceRight", "filter", "some", "every", "find", "findIndex", "findLast", "findLastIndex"]);
const FAN_OUT_METHODS = new Set(["map", "flatMap"]);
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

type Node = Rule.Node;
type Call = Extract<Node, { type: "CallExpression" }>;

function parentOf(node: Node): Node | null {
  return node.type === "Program" ? null : node.parent;
}

function calleeName({ callee }: CallExpression): string | null {
  if (callee.type === "Identifier") return callee.name;
  return callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier" ? callee.property.name : null;
}

/** The name alone is the check: no type information is read, so a context passed under another name is not seen. */
function isContext(node: { type: string; name?: string } | undefined): boolean {
  return node?.type === "Identifier" && node.name === "ctx";
}

function isStepOp(call: CallExpression): boolean {
  const { callee } = call;
  if (callee.type === "MemberExpression") return STEP_OPS.has(calleeName(call) ?? "") && isContext(callee.object);
  return callee.type === "Identifier" && STEP_WRAPPERS.has(callee.name) && isContext(call.arguments[0]);
}

function isAllCall(node: Node): boolean {
  return node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "all";
}

/** The `all(...)` that a `.map` call is a direct argument of, through array literals and spreads only. */
function fanOutOwner(mapCall: Node): Node | null {
  for (let parent = parentOf(mapCall); parent !== null; parent = parentOf(parent)) {
    if (isAllCall(parent)) return parent;
    if (parent.type !== "ArrayExpression" && parent.type !== "SpreadElement") return null;
  }
  return null;
}

/** The call a function is passed to as an argument; null for a callee, a declaration or a function held in a variable. */
function callTaking(fn: Node): Call | null {
  const parent = parentOf(fn);
  return parent?.type === "CallExpression" && (parent.arguments as readonly unknown[]).includes(fn) ? parent : null;
}

function isIterating(call: Call): boolean {
  const { callee } = call;
  const arrayFrom = callee.type === "MemberExpression" && callee.object.type === "Identifier" && callee.object.name === "Array";
  return LOOP_CALLBACKS.has(calleeName(call) ?? "") || (arrayFrom && calleeName(call) === "from");
}

/** The `all(...)` whose argument holds this `.map` or `.flatMap` call: the callbacks of that call are the sanctioned fan-out. */
function fanOutAll(call: Call): Node | null {
  return FAN_OUT_METHODS.has(calleeName(call) ?? "") ? fanOutOwner(call) : null;
}

/**
 * Whether a step op sits in a loop. The walk climbs through every function except the ones that end it: a `mapItems` callback,
 * which is a fan-out and not a loop (O5), and an iterating callback, which is a loop. A callback of `all(xs.map(…))` is the
 * sanctioned fan-out, so the walk goes on from that `all`, which must itself be in no loop.
 */
function inLoop(node: Node): boolean {
  for (let at = parentOf(node); at !== null; at = parentOf(at)) {
    if (LOOP_STATEMENTS.has(at.type)) return true;
    const call = FUNCTIONS.has(at.type) ? callTaking(at) : null;
    if (call === null) continue;
    if (calleeName(call) === "mapItems") return false;
    const all = fanOutAll(call);
    if (all !== null) return inLoop(all);
    if (isIterating(call)) return true;
  }
  return false;
}

/**
 * Flags a step op (`ctx.dispatch`, `ctx.seed`, `ctx.assisted`, `ctx.authorize`, or `step(ctx, …)` and `codeStep(ctx, …)`) called in a loop.
 * Residual: a helper declared outside the loop that holds the step op and is called in it is not seen, because the rule reads one function at a time.
 * The runtime orphan trap (TP-3108 S5) covers that case.
 */
export const recipeStepInLoop: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow a recipe step op called in a loop outside all(...)" },
    schema: [],
    messages: {
      stepInLoop:
        "A step called in a loop gets the same call site on every pass, so a replay cannot tell the passes apart. Fan out with `all([...items.map(…)])` or `mapItems`, or move the loop into a step body.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isStepOp(node)) return;
        if (inLoop(node)) context.report({ node, messageId: "stepInLoop" });
      },
    };
  },
};
