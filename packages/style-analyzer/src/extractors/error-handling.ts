import type { Node } from "web-tree-sitter";
import type { StyleExtractor, ParsedFile, Observation } from "./types.js";

const RESULT_TYPE_NAMES = new Set([
  "Result", "Either", "Ok", "Err", "Success", "Failure",
]);

const GENERIC_CATCH_TYPES = new Set([
  "Error", "Exception", "unknown",
]);

function isErrorClassName(name: string | null): boolean {
  return name !== null && (name.endsWith("Error") || name.endsWith("Exception"));
}

// `errors.NotFoundError` and `pkg.CustomException` name the class by their
// last segment; calls and other expressions name nothing.
function trailingName(node: Node): string | null {
  if (node.type === "identifier" || node.type === "type_identifier") return node.text;
  if (node.type === "member_expression") return node.childForFieldName("property")?.text ?? null;
  if (node.type === "attribute") return node.childForFieldName("attribute")?.text ?? null;
  return null;
}

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
    this.processDeclaration(node, file, observations);
    this.processFunctionCheck(node, file, observations);
  }

  private processDeclaration(
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
  }

  private processFunctionCheck(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
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
    const bases = file.language === "python"
      ? this.pythonBaseNodes(node)
      : this.extendsNodes(node);

    if (bases.some((base) => isErrorClassName(trailingName(base)))) {
      this.emit(observations, "error-handling.custom-error-class", true, file, node);
    }
  }

  private pythonBaseNodes(node: Node): Node[] {
    return node.childForFieldName("superclasses")?.namedChildren ?? [];
  }

  // TS wraps the base in `extends_clause`; JS puts it straight under
  // `class_heritage`. `implements` names an interface, not a base class.
  private extendsNodes(node: Node): Node[] {
    const heritage = node.children.find((c) => c.type === "class_heritage");
    if (!heritage) return [];
    const clause = heritage.namedChildren.find((c) => c.type === "extends_clause");
    if (!clause) return heritage.namedChildren.slice(0, 1);
    return clause.childrenForFieldName("value");
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

    const resultName = returnType
      .descendantsOfType("type_identifier")
      .find((id) => RESULT_TYPE_NAMES.has(id.text));
    if (resultName) {
      this.emit(observations, "error-handling.result-type", resultName.text, file, node);
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
