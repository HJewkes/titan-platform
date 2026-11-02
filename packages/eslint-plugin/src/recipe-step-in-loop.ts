import type { Rule } from "eslint";
import type { CallExpression } from "estree";

const STEP_OPS = new Set(["dispatch", "seed", "assisted", "authorize"]);
const STEP_WRAPPERS = new Set(["step", "codeStep"]);
const LOOP_STATEMENTS = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);
const LOOP_CALLBACKS = new Set(["map", "forEach", "flatMap", "reduce", "filter", "some", "every"]);
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

type Node = Rule.Node;

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

function isCallbackOf(fn: Node, names: ReadonlySet<string>): boolean {
  const parent = parentOf(fn);
  if (parent?.type !== "CallExpression" || !(parent.arguments as readonly unknown[]).includes(fn)) return false;
  return names.has(calleeName(parent) ?? "");
}

/** The nearest loop statement or iterating callback around a node. A function boundary ends the walk, and so does a `mapItems` callback, which is a fan-out and not a loop (O5). */
function nearestLoop(node: Node): Node | null {
  for (let at = parentOf(node); at !== null; at = parentOf(at)) {
    if (LOOP_STATEMENTS.has(at.type)) return at;
    if (!FUNCTIONS.has(at.type)) continue;
    return isCallbackOf(at, LOOP_CALLBACKS) ? at : null;
  }
  return null;
}

function enclosingAll(node: Node): Node | null {
  for (let at = parentOf(node); at !== null; at = parentOf(at)) {
    if (at.type === "CallExpression" && at.callee.type === "Identifier" && at.callee.name === "all") return at;
  }
  return null;
}

/** A loop inside the arguments of an `all(...)` that sits in no loop of its own is the sanctioned fan-out. */
function isSanctioned(loop: Node): boolean {
  const all = enclosingAll(loop);
  return all !== null && nearestLoop(all) === null;
}

/**
 * Flags a step op (`ctx.dispatch`, `ctx.seed`, `ctx.assisted`, `ctx.authorize`, or `step(ctx, …)` and `codeStep(ctx, …)`) called in a loop.
 * Residual: a helper that holds the step op and is called in a loop is not seen, because the rule reads one function at a time.
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
        const loop = nearestLoop(node);
        if (loop !== null && !isSanctioned(loop)) context.report({ node, messageId: "stepInLoop" });
      },
    };
  },
};
