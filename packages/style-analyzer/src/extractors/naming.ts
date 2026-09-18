import type { Node } from "web-tree-sitter";
import type { StyleExtractor, ParsedFile, Observation } from "./types.js";

const NAMING_PATTERNS: Record<string, RegExp> = {
  camelCase: /^[a-z][a-zA-Z0-9]*$/,
  PascalCase: /^[A-Z][a-zA-Z0-9]*$/,
  snake_case: /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/,
  SCREAMING_SNAKE: /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/,
  "kebab-case": /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/,
};

const BOOLEAN_PREFIXES = /^(is|has|should|can|will|did|was)[A-Z_]/;
const PYTHON_BOOLEAN_PREFIXES = /^(is|has|should|can|will|did|was)_/;

function detectConvention(name: string): string | null {
  for (const [convention, pattern] of Object.entries(NAMING_PATTERNS)) {
    if (pattern.test(name)) return convention;
  }
  if (/^[a-z][a-z0-9]*$/.test(name)) return "camelCase";
  return null;
}

function detectBooleanPrefix(name: string, language: string): string | null {
  const pattern = language === "python" ? PYTHON_BOOLEAN_PREFIXES : BOOLEAN_PREFIXES;
  const match = name.match(pattern);
  return match ? match[1]! : null;
}

// Blocks that do not open a new scope, so an assignment inside one still binds a module global.
const MODULE_SCOPE_BLOCKS = new Set([
  "block", "if_statement", "elif_clause", "else_clause",
  "try_statement", "except_clause", "finally_clause", "with_statement",
]);

// tree-sitter-python wraps an assignment in expression_statement; chained targets nest in assignment.
function isModuleLevelAssignment(node: Node): boolean {
  let scope = node.parent;
  while (scope?.type === "assignment") scope = scope.parent;
  if (scope?.type !== "expression_statement") return false;
  scope = scope.parent;
  while (scope && MODULE_SCOPE_BLOCKS.has(scope.type)) scope = scope.parent;
  return scope?.type === "module";
}

export class NamingExtractor implements StyleExtractor {
  readonly name = "naming";

  extract(file: ParsedFile): Observation[] {
    const observations: Observation[] = [];

    const visit = (node: Node): void => {
      this.processNode(node, file, observations);
      for (const child of node.children) {
        visit(child);
      }
    };

    visit(file.tree.rootNode);
    return observations;
  }

  private processNode(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    switch (file.language) {
      case "typescript":
      case "tsx":
        this.processTypeScriptNode(node, file, observations);
        break;
      case "python":
        this.processPythonNode(node, file, observations);
        break;
    }
  }

  private processTypeScriptNode(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    switch (node.type) {
      case "variable_declarator":
        this.processTypeScriptVariable(node, file, observations);
        break;
      case "function_declaration":
        this.observeDeclarationName(node, "naming.function", file, observations);
        break;
      case "interface_declaration":
      case "type_alias_declaration":
        this.observeDeclarationName(node, "naming.type", file, observations);
        break;
      case "enum_declaration":
        this.observeDeclarationName(node, "naming.enum", file, observations);
        break;
      case "class_declaration":
        if (this.observeDeclarationName(node, "naming.type", file, observations)) {
          this.detectPrivateMembers(node, file, observations);
        }
        break;
      case "required_parameter":
      case "optional_parameter":
        this.processTypeScriptParameter(node, file, observations);
        break;
    }
  }

  private processTypeScriptVariable(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    const nameNode = node.childForFieldName("name");
    if (!nameNode || nameNode.type !== "identifier") return;
    const name = nameNode.text;

    const declKind = node.parent?.type === "lexical_declaration"
      ? node.parent.children[0]?.text
      : null;

    if (declKind === "const" && NAMING_PATTERNS.SCREAMING_SNAKE!.test(name)) {
      this.addObservation(observations, "naming.constant", "SCREAMING_SNAKE", file, node);
      return;
    }

    this.observeVariable(name, node, file, observations);
  }

  private processTypeScriptParameter(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    const nameNode = node.childForFieldName("pattern") ?? node.childForFieldName("name");
    if (!nameNode || nameNode.type !== "identifier") return;
    if (nameNode.text === "this") return;
    const convention = detectConvention(nameNode.text);
    if (convention) {
      this.addObservation(observations, "naming.parameter", convention, file, node);
    }
  }

  private processPythonNode(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    switch (node.type) {
      case "assignment":
        this.processPythonAssignment(node, file, observations);
        break;
      case "function_definition": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) break;
        if (nameNode.text.startsWith("__") && nameNode.text.endsWith("__")) break;
        this.observeDeclarationName(node, "naming.function", file, observations);
        break;
      }
      case "class_definition":
        this.observeDeclarationName(node, "naming.type", file, observations);
        break;
      case "parameters":
        this.processPythonParameters(node, file, observations);
        break;
    }
  }

  private processPythonAssignment(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    const left = node.childForFieldName("left");
    if (!left || left.type !== "identifier") return;
    const name = left.text;

    if (
      isModuleLevelAssignment(node) &&
      NAMING_PATTERNS.SCREAMING_SNAKE!.test(name)
    ) {
      this.addObservation(observations, "naming.constant", "SCREAMING_SNAKE", file, node);
      return;
    }

    this.observeVariable(name, node, file, observations);
  }

  private processPythonParameters(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    for (const child of node.children) {
      if (child.type === "identifier" && child.text !== "self" && child.text !== "cls") {
        const convention = detectConvention(child.text);
        if (convention) {
          this.addObservation(observations, "naming.parameter", convention, file, child);
        }
      }
      if (child.type === "typed_parameter") {
        const paramName = child.childForFieldName("name") ?? child.children[0];
        if (paramName && paramName.type === "identifier" && paramName.text !== "self") {
          const convention = detectConvention(paramName.text);
          if (convention) {
            this.addObservation(observations, "naming.parameter", convention, file, child);
          }
        }
      }
    }
  }

  private observeVariable(
    name: string,
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    const prefix = detectBooleanPrefix(name, file.language);
    if (prefix) {
      this.addObservation(observations, "naming.boolean", prefix, file, node);
    }

    const convention = detectConvention(name);
    if (convention) {
      this.addObservation(observations, "naming.variable", convention, file, node);
    }
  }

  // Returns whether the node had a name, because a nameless class skips its private-member scan.
  private observeDeclarationName(
    node: Node,
    type: string,
    file: ParsedFile,
    observations: Observation[],
  ): boolean {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return false;
    const convention = detectConvention(nameNode.text);
    if (convention) {
      this.addObservation(observations, type, convention, file, node);
    }
    return true;
  }

  private detectPrivateMembers(
    classNode: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    const body = classNode.childForFieldName("body");
    if (!body) return;

    for (const member of body.children) {
      if (member.type === "public_field_definition") {
        const nameNode = member.childForFieldName("name");
        if (!nameNode) continue;
        const name = nameNode.text;

        if (name.startsWith("#")) {
          this.addObservation(observations, "naming.private-member", "hash-prefix", file, member);
        } else if (name.startsWith("_") && !name.startsWith("__")) {
          this.addObservation(observations, "naming.private-member", "underscore-prefix", file, member);
        }
      }
    }
  }

  private addObservation(
    observations: Observation[],
    type: string,
    value: string | number | boolean,
    file: ParsedFile,
    node: Node,
  ): void {
    observations.push({
      type,
      category: "naming",
      value,
      file: file.filePath,
      line: node.startPosition.row + 1,
    });
  }
}
