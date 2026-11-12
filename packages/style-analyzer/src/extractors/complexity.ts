import type { Node } from "web-tree-sitter";
import { cyclomaticOf, nestingDepthOf } from "@titan-design/code-parser";
import {
  PY_FUNCTION_TYPES,
  TS_FUNCTION_DECLARATION,
  TS_METHOD_DEFINITION,
} from "@titan-design/code-parser/node-kinds";
import type { StyleExtractor, ParsedFile, Observation } from "./types.js";

interface FunctionInfo {
  name: string;
  statementCount: number;
  maxNestingDepth: number;
  cyclomaticComplexity: number;
  line: number;
}

// Generators are left out on purpose: the complexity metric has always counted only these two.
const TS_FUNCTION_TYPES: ReadonlySet<string> = new Set([TS_FUNCTION_DECLARATION, TS_METHOD_DEFINITION]);

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

  private getFunctionTypes(language: string): ReadonlySet<string> {
    return language === "python" ? PY_FUNCTION_TYPES : TS_FUNCTION_TYPES;
  }

  private findFunctions(
    root: Node,
    functionTypes: ReadonlySet<string>,
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
    const maxNestingDepth = nestingDepthOf(body, language);
    const cyclomaticComplexity = cyclomaticOf(body, language);

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
}
