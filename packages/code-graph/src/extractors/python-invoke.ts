import type { Node } from "web-tree-sitter";
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

/** Per scope: names bound to a `CliRunner()` or annotated `CliRunner`, and every name a plain assignment binds. */
function collectBindings(root: Node): { runners: Set<string>; assigned: Set<string> } {
  const runners = new Set<string>();
  const assigned = new Set<string>();
  walkScopes(root, true, (node, scope) => {
    if (node.type === "assignment") {
      const left = node.childForFieldName("left");
      if (left?.type !== "identifier") return;
      assigned.add(key(scope, left.text));
      if (isRunnerConstruction(node.childForFieldName("right"))) runners.add(key(scope, left.text));
    } else if (TYPED_PARAMS.has(node.type) && CLI_RUNNER.test(node.childForFieldName("type")?.text ?? "")) {
      const id = node.namedChildren.find((c) => c?.type === "identifier");
      if (id) runners.add(key(scope, id.text));
    }
  });
  return { runners, assigned };
}

/**
 * The bare name a click `CliRunner` runs at this call, or null: `runner.invoke(cmd, ...)` where the receiver is a
 * `CliRunner()` construction or a name bound to or annotated as one. `Mock().invoke(x)` and other receivers are not
 * invocations. A target name the function rebinds itself (`other = sub; runner.invoke(other)`) credits nothing,
 * since following the alias would need data flow the extractor does not have. `runner.invoke(cli, ["sub"])` names
 * only the group `cli`; the subcommand is chosen at run time from argv, so only the group is credited.
 */
export function invokedCommands(root: Node): (call: Node, args: Node, scope: string) => string | null {
  const { runners, assigned } = collectBindings(root);
  const bound = (set: Set<string>, scope: string, name: string, stopAtModule: boolean) =>
    scopeChain(scope).some((s) => (s !== "" || !stopAtModule) && set.has(key(s, name)));
  return (call, args, scope) => {
    const callee = call.childForFieldName("function");
    if (callee?.type !== "attribute" || callee.childForFieldName("attribute")?.text !== "invoke") return null;
    const receiver = callee.childForFieldName("object");
    const isRunner =
      isRunnerConstruction(receiver) || (receiver?.type === "identifier" && bound(runners, scope, receiver.text, false));
    const target = args.namedChildren[0];
    if (!isRunner || target?.type !== "identifier" || bound(assigned, scope, target.text, true)) return null;
    return target.text;
  };
}
