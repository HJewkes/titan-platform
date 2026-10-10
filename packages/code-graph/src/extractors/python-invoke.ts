import type { Node } from "web-tree-sitter";
import { forEachBinding } from "../python-bindings.js";
import { walkScopes } from "../scope-path.js";

const CLI_RUNNER = /(?:^|\.)CliRunner$/;
const TYPED_PARAMS = new Set(["typed_parameter", "typed_default_parameter"]);

const key = (scope: string, name: string): string => `${scope}\0${name}`;

/** `scope` and each enclosing scope out to the module, innermost first. */
function scopeChain(scope: string): string[] {
  const segments = scope ? scope.split(".") : [];
  return segments.map((_, i) => segments.slice(0, segments.length - i).join(".")).concat("");
}

function isRunnerConstruction(node: Node | null): boolean {
  return node?.type === "call" && CLI_RUNNER.test(node.childForFieldName("function")?.text ?? "");
}

type BindingKind = "runner" | "other";

/** A parameter's name, and whether its annotation makes it a `CliRunner`. */
function parameterBinding(param: Node): { name: string; kind: BindingKind } | null {
  const id = param.type === "identifier" ? param : param.namedChildren.find((c) => c.type === "identifier");
  if (!id) return null;
  const typed = TYPED_PARAMS.has(param.type) && CLI_RUNNER.test(param.childForFieldName("type")?.text ?? "");
  return { name: id.text, kind: typed ? "runner" : "other" };
}

/**
 * Every binding of every name, per scope: `runner` only when each binding of the name in that scope is a
 * `CliRunner()` assignment or a `CliRunner`-annotated parameter; any other binding form makes it `other`.
 */
function collectBindings(root: Node): Map<string, BindingKind> {
  const kinds = new Map<string, BindingKind>();
  const record = (scope: string, name: string, kind: BindingKind) => {
    const k = key(scope, name);
    kinds.set(k, kinds.get(k) === "other" ? "other" : kind);
  };
  walkScopes(root, true, (node, scope) => {
    if (node.type === "parameters") {
      for (const param of node.namedChildren) {
        const binding = parameterBinding(param);
        if (binding) record(scope, binding.name, binding.kind);
      }
      return;
    }
    forEachBinding(node, (name, rhs) => record(scope, name, isRunnerConstruction(rhs) ? "runner" : "other"));
  });
  return kinds;
}

/**
 * The bare name a click `CliRunner` runs at this call, or null: `runner.invoke(cmd, ...)` where the receiver is a
 * `CliRunner()` construction, or a name whose innermost binding scope binds it only to one, so a parameter or local
 * shadowing a module-level runner (`runner = Mock()`) is no runner. `Mock().invoke(x)` and other receivers are not
 * invocations. A target the function rebinds in any form (`other = sub; runner.invoke(other)`) credits nothing,
 * since following the alias would need data flow the extractor does not have. `runner.invoke(cli, ["sub"])` names
 * only the group `cli`; the subcommand is chosen at run time from argv, so only the group is credited.
 */
export function invokedCommands(root: Node): (call: Node, args: Node, scope: string) => string | null {
  const kinds = collectBindings(root);
  const innermost = (scope: string, name: string): BindingKind | undefined =>
    scopeChain(scope).map((s) => kinds.get(key(s, name))).find((k) => k !== undefined);
  const boundInFunction = (scope: string, name: string): boolean =>
    scopeChain(scope).some((s) => s !== "" && kinds.has(key(s, name)));
  return (call, args, scope) => {
    const callee = call.childForFieldName("function");
    if (callee?.type !== "attribute" || callee.childForFieldName("attribute")?.text !== "invoke") return null;
    const receiver = callee.childForFieldName("object");
    const isRunner =
      isRunnerConstruction(receiver) || (receiver?.type === "identifier" && innermost(scope, receiver.text) === "runner");
    const target = args.namedChildren[0];
    if (!isRunner || target?.type !== "identifier" || boundInFunction(scope, target.text)) return null;
    return target.text;
  };
}
