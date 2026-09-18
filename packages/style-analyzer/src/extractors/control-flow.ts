import type { Node } from "web-tree-sitter";
import type { StyleExtractor, ParsedFile, Observation } from "./types.js";

const ARRAY_METHODS = new Set([
  "map", "filter", "reduce", "forEach", "find", "some", "every", "flatMap",
  "findIndex",
]);

export class ControlFlowExtractor implements StyleExtractor {
  readonly name = "control-flow";

  extract(file: ParsedFile): Observation[] {
    const observations: Observation[] = [];
    this.walk(file.tree.rootNode, file, observations);
    return observations;
  }

  private walk(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    this.processNode(node, file, observations);
    for (const child of node.children) {
      this.walk(child, file, observations);
    }
  }

  private processNode(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    if (
      node.type === "ternary_expression" ||
      node.type === "conditional_expression"
    ) {
      this.emit(observations, "control-flow.ternary", true, file, node);
    }

    if (node.type === "if_statement") {
      this.emit(observations, "control-flow.if-else", true, file, node);
      this.detectGuardClause(node, file, observations);
      this.detectElseAfterReturn(node, file, observations);
    }

    if (node.type === "for_statement" && file.language !== "python") {
      this.emit(observations, "control-flow.for-loop", true, file, node);
    }

    if (node.type === "for_in_statement") {
      const isForOf = node.children.some((c) => c.type === "of");
      this.emit(
        observations,
        isForOf ? "control-flow.for-of" : "control-flow.for-in",
        true,
        file,
        node,
      );
    }

    if (node.type === "for_statement" && file.language === "python") {
      this.emit(observations, "control-flow.for-loop", true, file, node);
    }

    if (
      node.type === "list_comprehension" ||
      node.type === "set_comprehension" ||
      node.type === "dictionary_comprehension" ||
      node.type === "generator_expression"
    ) {
      this.emit(observations, "control-flow.array-method", true, file, node);
    }

    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn?.type === "member_expression") {
        const property = fn.childForFieldName("property");
        if (property) {
          const methodName = property.text;
          if (ARRAY_METHODS.has(methodName)) {
            this.emit(
              observations,
              "control-flow.array-method",
              methodName,
              file,
              node,
            );
          }
          if (methodName === "then") {
            this.emit(
              observations,
              "control-flow.promise-then",
              true,
              file,
              node,
            );
          }
        }
      }
    }

    if (node.type === "await_expression") {
      this.emit(observations, "control-flow.async-await", true, file, node);
    }
  }

  private detectGuardClause(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    const parent = node.parent;
    if (!parent) return;

    const isFunctionBody =
      parent.type === "statement_block" &&
      (parent.parent?.type === "function_declaration" ||
        parent.parent?.type === "method_definition" ||
        parent.parent?.type === "arrow_function");

    const isPythonFunctionBody =
      parent.type === "block" &&
      parent.parent?.type === "function_definition";

    if (!isFunctionBody && !isPythonFunctionBody) return;

    const siblings = parent.children.filter(
      (c) => c.type !== "comment" && c.type !== "{" && c.type !== "}",
    );
    const nodeIndex = siblings.indexOf(node);
    if (nodeIndex > 2) return;

    const consequent =
      node.childForFieldName("consequence") ??
      node.childForFieldName("body");
    if (!consequent) return;

    const hasReturn = this.containsReturn(consequent);
    const hasElse = node.childForFieldName("alternative") !== null;

    if (hasReturn && !hasElse) {
      this.emit(
        observations,
        "control-flow.guard-clause",
        true,
        file,
        node,
      );
    }
  }

  private detectElseAfterReturn(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    const consequent =
      node.childForFieldName("consequence") ??
      node.childForFieldName("body");
    const alternative = node.childForFieldName("alternative");

    if (!consequent || !alternative) return;

    if (this.containsReturn(consequent)) {
      this.emit(
        observations,
        "control-flow.else-after-return",
        true,
        file,
        node,
      );
    }
  }

  private containsReturn(node: Node): boolean {
    if (node.type === "return_statement") return true;
    for (const child of node.children) {
      if (child.type === "return_statement") return true;
    }
    return false;
  }

  private emit(
    observations: Observation[],
    type: string,
    value: string | number | boolean,
    file: ParsedFile,
    node: Node,
  ): void {
    observations.push({
      type,
      category: "control-flow",
      value,
      file: file.filePath,
      line: node.startPosition.row + 1,
    });
  }
}
