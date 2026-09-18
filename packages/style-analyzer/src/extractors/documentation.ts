import type { Node } from "web-tree-sitter";
import type { StyleExtractor, ParsedFile, Observation } from "./types.js";

const JSDOC_TAG_PATTERN = /@(param|returns?|throws?|example|deprecated|see|since|type|typedef|template|callback|async)\b/g;
const PYTHON_DOC_TAG_PATTERN = /^[ \t]*(Args|Returns?|Raises?|Yields?|Note|Notes|Example|Attributes|Todo|References):/gm;

export class DocumentationExtractor implements StyleExtractor {
  readonly name = "documentation";

  extract(file: ParsedFile): Observation[] {
    const observations: Observation[] = [];

    this.walkDeclarations(file.tree.rootNode, file, observations);
    this.walkForComments(file.tree.rootNode, file, observations);

    return observations;
  }

  private walkDeclarations(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    for (const child of node.children) {
      if (this.isDeclaration(child, file.language)) {
        this.processDeclaration(child, file, observations);
      }

      if (
        child.type === "class_declaration" ||
        child.type === "class_definition" ||
        child.type === "class_body" ||
        child.type === "block"
      ) {
        this.walkDeclarations(child, file, observations);
      }

      if (child.type === "export_statement") {
        this.walkDeclarations(child, file, observations);
      }
    }
  }

  private isDeclaration(node: Node, language: string): boolean {
    if (language === "python") {
      return (
        node.type === "function_definition" ||
        node.type === "class_definition"
      );
    }
    return (
      node.type === "function_declaration" ||
      node.type === "method_definition" ||
      node.type === "class_declaration" ||
      node.type === "interface_declaration" ||
      node.type === "type_alias_declaration"
    );
  }

  private processDeclaration(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    const isExported = this.isExported(node, file.language);
    const hasDoc = this.hasLeadingDoc(node, file.language);

    this.emit(observations, "documentation.jsdoc-presence", hasDoc, file, node);

    const coverageType = isExported
      ? "documentation.public-coverage"
      : "documentation.private-coverage";
    this.emit(observations, coverageType, hasDoc, file, node);

    if (hasDoc) {
      this.extractTags(node, file, observations);
    }
  }

  private hasLeadingDoc(node: Node, language: string): boolean {
    if (language === "python") {
      return this.hasPythonDocstring(node);
    }
    return this.hasJSDoc(node);
  }

  private hasJSDoc(node: Node): boolean {
    const prev = node.previousSibling;
    if (prev?.type === "comment" && prev.text.startsWith("/**")) {
      return true;
    }
    if (node.parent?.type === "export_statement") {
      const exportPrev = node.parent.previousSibling;
      if (exportPrev?.type === "comment" && exportPrev.text.startsWith("/**")) {
        return true;
      }
    }
    return false;
  }

  private hasPythonDocstring(node: Node): boolean {
    const body = node.childForFieldName("body");
    if (!body) return false;

    const firstStatement = body.children.find(
      (c) => c.type !== "comment" && c.type !== "newline",
    );
    if (!firstStatement) return false;

    if (firstStatement.type === "expression_statement") {
      const expr = firstStatement.children[0];
      return expr?.type === "string" || expr?.type === "concatenated_string";
    }
    return false;
  }

  private extractTags(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    if (file.language === "python") {
      this.extractPythonDocTags(node, file, observations);
      return;
    }

    const commentNode = this.getLeadingComment(node);
    if (!commentNode) return;

    const text = commentNode.text;
    const tagMatches = text.matchAll(JSDOC_TAG_PATTERN);
    const seenTags = new Set<string>();

    for (const match of tagMatches) {
      const tag = `@${match[1]}`;
      const normalized = tag
        .replace(/^@return$/, "@returns")
        .replace(/^@throw$/, "@throws");

      if (seenTags.has(normalized)) continue;
      seenTags.add(normalized);

      this.emit(observations, "documentation.jsdoc-tag", normalized, file, commentNode);
    }
  }

  private extractPythonDocTags(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    const body = node.childForFieldName("body");
    if (!body) return;

    const firstStatement = body.children.find(
      (c) => c.type === "expression_statement",
    );
    if (!firstStatement) return;

    const expr = firstStatement.children[0];
    if (!expr) return;

    const text = expr.text;
    const tagMatches = text.matchAll(PYTHON_DOC_TAG_PATTERN);
    const seenTags = new Set<string>();

    for (const match of tagMatches) {
      const tag = match[1]!;
      if (seenTags.has(tag)) continue;
      seenTags.add(tag);
      this.emit(observations, "documentation.jsdoc-tag", tag, file, expr);
    }
  }

  private walkForComments(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    if (node.type === "comment") {
      if (!node.text.startsWith("/**")) {
        this.emit(observations, "documentation.inline-comment", true, file, node);

        const placement = this.getCommentPlacement(node);
        this.emit(observations, "documentation.comment-placement", placement, file, node);
      }
    }

    for (const child of node.children) {
      this.walkForComments(child, file, observations);
    }
  }

  private getCommentPlacement(node: Node): "leading" | "trailing" {
    const prev = node.previousSibling;
    if (prev && prev.endPosition.row === node.startPosition.row) {
      return "trailing";
    }
    return "leading";
  }

  private isExported(node: Node, language: string): boolean {
    if (language === "python") {
      const nameNode = node.childForFieldName("name");
      return (
        node.parent?.type === "module" &&
        !!nameNode &&
        !nameNode.text.startsWith("_")
      );
    }
    return node.parent?.type === "export_statement";
  }

  private getLeadingComment(node: Node): Node | null {
    const prev = node.previousSibling;
    if (prev?.type === "comment" && prev.text.startsWith("/**")) {
      return prev;
    }
    if (node.parent?.type === "export_statement") {
      const exportPrev = node.parent.previousSibling;
      if (exportPrev?.type === "comment" && exportPrev.text.startsWith("/**")) {
        return exportPrev;
      }
    }
    return null;
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
      category: "documentation",
      value,
      file: file.filePath,
      line: node.startPosition.row + 1,
    });
  }
}
