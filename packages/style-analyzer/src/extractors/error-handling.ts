import type { Node } from "web-tree-sitter";
import type { StyleExtractor, ParsedFile, Observation } from "./types.js";

const RESULT_TYPE_NAMES = new Set([
  "Result", "Either", "Ok", "Err", "Success", "Failure",
]);

const GENERIC_CATCH_TYPES = new Set([
  "Error", "Exception", "unknown",
]);

export class ErrorHandlingExtractor implements StyleExtractor {
  readonly name = "error-handling";

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
    if (node.type === "try_statement") {
      this.emit(observations, "error-handling.try-catch", true, file, node);
      this.analyzeCatchClauses(node, file, observations);
    }

    if (
      node.type === "class_declaration" ||
      node.type === "class_definition"
    ) {
      this.detectCustomErrorClass(node, file, observations);
    }

    if (
      node.type === "type_alias_declaration" &&
      (file.language === "typescript" || file.language === "tsx")
    ) {
      this.detectResultType(node, file, observations);
    }

    if (
      node.type === "function_declaration" ||
      node.type === "method_definition"
    ) {
      this.detectResultReturnType(node, file, observations);
    }

    if (node.type === "function_declaration") {
      this.detectAssertNever(node, file, observations);
    }

    if (node.type === "switch_statement") {
      this.detectExhaustiveSwitch(node, file, observations);
    }
  }

  private analyzeCatchClauses(
    tryNode: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    for (const child of tryNode.children) {
      if (child.type === "catch_clause") {
        const body = child.childForFieldName("body");
        if (body && this.hasInstanceofCheck(body)) {
          this.emit(observations, "error-handling.catch-specificity", "specific", file, child);
        } else {
          this.emit(observations, "error-handling.catch-specificity", "generic", file, child);
        }
      }

      if (child.type === "except_clause") {
        const typeNode = child.children.find(
          (c) => c.type === "identifier" || c.type === "attribute",
        );

        if (typeNode && !GENERIC_CATCH_TYPES.has(typeNode.text)) {
          this.emit(observations, "error-handling.catch-specificity", "specific", file, child);
        } else {
          this.emit(observations, "error-handling.catch-specificity", "generic", file, child);
        }
      }
    }
  }

  private hasInstanceofCheck(body: Node): boolean {
    return body.text.includes("instanceof");
  }

  private detectCustomErrorClass(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    if (file.language === "python") {
      const superclasses = node.childForFieldName("superclasses");
      if (!superclasses) return;

      const bases = superclasses.text;
      if (bases.includes("Error") || bases.includes("Exception")) {
        this.emit(observations, "error-handling.custom-error-class", true, file, node);
      }
      return;
    }

    const heritage = node.children.find(
      (c) => c.type === "class_heritage",
    );
    if (!heritage) return;

    if (heritage.text.includes("Error")) {
      this.emit(observations, "error-handling.custom-error-class", true, file, node);
    }
  }

  private detectResultType(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    if (RESULT_TYPE_NAMES.has(nameNode.text)) {
      this.emit(observations, "error-handling.result-type", nameNode.text, file, node);
    }
  }

  private detectResultReturnType(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    const returnType = node.childForFieldName("return_type");
    if (!returnType) return;

    const text = returnType.text;
    for (const name of RESULT_TYPE_NAMES) {
      if (text.includes(name)) {
        this.emit(observations, "error-handling.result-type", name, file, node);
        break;
      }
    }
  }

  private detectAssertNever(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;

    const name = nameNode.text;
    if (name !== "assertNever" && name !== "absurd") return;

    const params = node.childForFieldName("parameters");
    const returnType = node.childForFieldName("return_type");

    const hasNeverParam = params?.text.includes("never") ?? false;
    const returnsNever = returnType?.text.includes("never") ?? false;

    if (hasNeverParam || returnsNever) {
      this.emit(observations, "error-handling.assert-never", true, file, node);
    }
  }

  private detectExhaustiveSwitch(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    const body = node.childForFieldName("body");
    if (!body) return;

    let defaultCallsAssertNever = false;

    for (const child of body.children) {
      if (child.type === "switch_default") {
        const text = child.text;
        if (text.includes("assertNever") || text.includes("absurd")) {
          defaultCallsAssertNever = true;
        }
      }
    }

    this.emit(
      observations,
      "error-handling.exhaustive-switch",
      defaultCallsAssertNever,
      file,
      node,
    );
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
      category: "error-handling",
      value,
      file: file.filePath,
      line: node.startPosition.row + 1,
    });
  }
}
