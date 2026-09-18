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
      case "variable_declarator": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode || nameNode.type !== "identifier") break;
        const name = nameNode.text;

        const declKind = node.parent?.type === "lexical_declaration"
          ? node.parent.children[0]?.text
          : null;

        if (declKind === "const" && NAMING_PATTERNS.SCREAMING_SNAKE!.test(name)) {
          this.addObservation(observations, "naming.constant", "SCREAMING_SNAKE", file, node);
          break;
        }

        const prefix = detectBooleanPrefix(name, file.language);
        if (prefix) {
          this.addObservation(observations, "naming.boolean", prefix, file, node);
        }

        const convention = detectConvention(name);
        if (convention) {
          this.addObservation(observations, "naming.variable", convention, file, node);
        }
        break;
      }

      case "function_declaration": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) break;
        const convention = detectConvention(nameNode.text);
        if (convention) {
          this.addObservation(observations, "naming.function", convention, file, node);
        }
        break;
      }

      case "interface_declaration":
      case "type_alias_declaration": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) break;
        const convention = detectConvention(nameNode.text);
        if (convention) {
          this.addObservation(observations, "naming.type", convention, file, node);
        }
        break;
      }

      case "enum_declaration": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) break;
        const convention = detectConvention(nameNode.text);
        if (convention) {
          this.addObservation(observations, "naming.enum", convention, file, node);
        }
        break;
      }

      case "class_declaration": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) break;
        const convention = detectConvention(nameNode.text);
        if (convention) {
          this.addObservation(observations, "naming.type", convention, file, node);
        }

        this.detectPrivateMembers(node, file, observations);
        break;
      }

      case "required_parameter":
      case "optional_parameter": {
        const nameNode = node.childForFieldName("pattern") ?? node.childForFieldName("name");
        if (!nameNode || nameNode.type !== "identifier") break;
        if (nameNode.text === "this") break;
        const convention = detectConvention(nameNode.text);
        if (convention) {
          this.addObservation(observations, "naming.parameter", convention, file, node);
        }
        break;
      }
    }
  }

  private processPythonNode(
    node: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    switch (node.type) {
      case "assignment": {
        const left = node.childForFieldName("left");
        if (!left || left.type !== "identifier") break;
        const name = left.text;

        if (
          node.parent?.type === "module" &&
          NAMING_PATTERNS.SCREAMING_SNAKE!.test(name)
        ) {
          this.addObservation(observations, "naming.constant", "SCREAMING_SNAKE", file, node);
          break;
        }

        const prefix = detectBooleanPrefix(name, file.language);
        if (prefix) {
          this.addObservation(observations, "naming.boolean", prefix, file, node);
        }

        const convention = detectConvention(name);
        if (convention) {
          this.addObservation(observations, "naming.variable", convention, file, node);
        }
        break;
      }

      case "function_definition": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) break;
        if (nameNode.text.startsWith("__") && nameNode.text.endsWith("__")) break;

        const convention = detectConvention(nameNode.text);
        if (convention) {
          this.addObservation(observations, "naming.function", convention, file, node);
        }
        break;
      }

      case "class_definition": {
        const nameNode = node.childForFieldName("name");
        if (!nameNode) break;
        const convention = detectConvention(nameNode.text);
        if (convention) {
          this.addObservation(observations, "naming.type", convention, file, node);
        }
        break;
      }

      case "parameters": {
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
        break;
      }
    }
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
