import type { Node } from "web-tree-sitter";
import type { StyleExtractor, ParsedFile, Observation } from "./types.js";

interface FunctionInfo {
  name: string;
  statementCount: number;
  maxNestingDepth: number;
  cyclomaticComplexity: number;
  line: number;
}

const TS_FUNCTION_TYPES = new Set([
  "function_declaration",
  "method_definition",
]);

const PY_FUNCTION_TYPES = new Set([
  "function_definition",
]);

const TS_NESTING_TYPES = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
  "try_statement",
]);

const PY_NESTING_TYPES = new Set([
  "if_statement",
  "for_statement",
  "while_statement",
  "try_statement",
]);

const TS_BRANCH_TYPES = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_case",
  "catch_clause",
  "ternary_expression",
]);

const PY_BRANCH_TYPES = new Set([
  "if_statement",
  "elif_clause",
  "for_statement",
  "while_statement",
  "except_clause",
  "conditional_expression",
]);

export class ComplexityExtractor implements StyleExtractor {
  readonly name = "complexity";

  extract(file: ParsedFile): Observation[] {
    const observations: Observation[] = [];

    const lineCount = file.content
      .split("\n")
      .filter((l) => l.trim() !== "").length;

    observations.push({
      type: "complexity.fileLength",
      category: "complexity",
      value: lineCount,
      file: file.filePath,
      line: 1,
    });

    const functionTypes = this.getFunctionTypes(file.language);
    const functions = this.findFunctions(
      file.tree.rootNode, functionTypes, file.language,
    );

    for (const fn of functions) {
      observations.push(...this.functionObservations(fn, file.filePath));
    }

    return observations;
  }

  private functionObservations(fn: FunctionInfo, filePath: string): Observation[] {
    const metrics: Array<[string, number]> = [
      ["complexity.functionLength", fn.statementCount],
      ["complexity.nestingDepth", fn.maxNestingDepth],
      ["complexity.cyclomatic", fn.cyclomaticComplexity],
    ];
    return metrics.map(([type, value]) => ({
      type,
      category: "complexity",
      value,
      file: filePath,
      line: fn.line,
      metadata: { functionName: fn.name },
    }));
  }

  private getFunctionTypes(language: string): Set<string> {
    return language === "python" ? PY_FUNCTION_TYPES : TS_FUNCTION_TYPES;
  }

  private findFunctions(
    root: Node,
    functionTypes: Set<string>,
    language: string,
  ): FunctionInfo[] {
    const functions: FunctionInfo[] = [];

    const visit = (node: Node): void => {
      if (functionTypes.has(node.type)) {
        const info = this.analyzeFunctionNode(node, language);
        if (info) functions.push(info);
      }
      for (const child of node.children) {
        visit(child);
      }
    };

    visit(root);
    return functions;
  }

  private analyzeFunctionNode(
    node: Node,
    language: string,
  ): FunctionInfo | null {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    const name = nameNode.text;

    const body = node.childForFieldName("body");
    if (!body) return null;

    const statementCount = this.countStatements(body, language);
    const maxNestingDepth = this.measureNestingDepth(body, language, 0);
    const cyclomaticComplexity = this.measureCyclomaticComplexity(
      body, language,
    );

    return {
      name,
      statementCount,
      maxNestingDepth,
      cyclomaticComplexity,
      line: node.startPosition.row + 1,
    };
  }

  private countStatements(body: Node, language: string): number {
    let count = 0;
    for (const child of body.namedChildren) {
      if (this.isStatement(child, language)) {
        count++;
      }
    }
    return count;
  }

  private isStatement(node: Node, language: string): boolean {
    if (language === "python") {
      return this.isPythonStatement(node);
    }
    return this.isTypeScriptStatement(node);
  }

  private isTypeScriptStatement(node: Node): boolean {
    const statementTypes = new Set([
      "lexical_declaration",
      "variable_declaration",
      "expression_statement",
      "return_statement",
      "if_statement",
      "for_statement",
      "for_in_statement",
      "while_statement",
      "do_statement",
      "switch_statement",
      "try_statement",
      "throw_statement",
      "break_statement",
      "continue_statement",
    ]);
    return statementTypes.has(node.type);
  }

  private isPythonStatement(node: Node): boolean {
    const statementTypes = new Set([
      "expression_statement",
      "return_statement",
      "if_statement",
      "for_statement",
      "while_statement",
      "try_statement",
      "raise_statement",
      "assert_statement",
      "pass_statement",
      "break_statement",
      "continue_statement",
      "assignment",
      "augmented_assignment",
    ]);
    return statementTypes.has(node.type);
  }

  private measureNestingDepth(
    node: Node,
    language: string,
    depth: number,
  ): number {
    const nestingTypes = language === "python"
      ? PY_NESTING_TYPES
      : TS_NESTING_TYPES;

    let maxDepth = depth;

    for (const child of node.namedChildren) {
      if (nestingTypes.has(child.type)) {
        const childMax = this.measureNestingDepth(
          child, language, depth + 1,
        );
        if (childMax > maxDepth) maxDepth = childMax;
      } else {
        const childMax = this.measureNestingDepth(
          child, language, depth,
        );
        if (childMax > maxDepth) maxDepth = childMax;
      }
    }

    return maxDepth;
  }

  private measureCyclomaticComplexity(
    body: Node,
    language: string,
  ): number {
    let complexity = 1;
    const branchTypes = language === "python"
      ? PY_BRANCH_TYPES
      : TS_BRANCH_TYPES;

    const visit = (node: Node): void => {
      complexity += this.branchIncrement(node, language, branchTypes);

      for (const child of node.namedChildren) {
        visit(child);
      }
    };

    visit(body);
    return complexity;
  }

  private branchIncrement(
    node: Node,
    language: string,
    branchTypes: Set<string>,
  ): number {
    let increment = 0;
    if (branchTypes.has(node.type)) {
      increment++;
    }

    if (node.type === "binary_expression") {
      const operator = node.childForFieldName("operator");
      if (operator) {
        const text = operator.text;
        if (text === "&&" || text === "||") {
          increment++;
        }
      }
    }

    if (
      language === "python" &&
      node.type === "boolean_operator"
    ) {
      increment++;
    }
    return increment;
  }
}
