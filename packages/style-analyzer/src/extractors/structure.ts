import type { Node } from "web-tree-sitter";
import type { StyleExtractor, ParsedFile, Observation } from "./types.js";

const PYTHON_BUILTINS = new Set([
  "os", "sys", "re", "json", "math", "time", "datetime", "pathlib",
  "collections", "itertools", "functools", "typing", "io", "abc",
  "dataclasses", "enum", "logging", "unittest", "hashlib", "subprocess",
  "argparse", "copy", "glob", "shutil", "tempfile", "textwrap",
  "contextlib", "operator", "string", "struct", "csv", "xml",
]);

function classifyImportSource(source: string, language: string): string {
  if (language === "python") {
    if (source.startsWith(".")) return "relative";
    const topModule = source.split(".")[0]!;
    if (PYTHON_BUILTINS.has(topModule)) return "builtin";
    return "external";
  }

  if (source.startsWith("node:")) return "builtin";
  if (source.startsWith(".") || source.startsWith("..")) return "relative";
  if (source.startsWith("@")) {
    const scope = source.split("/")[0]!;
    if (["@app", "@lib", "@src", "@internal", "@modules"].includes(scope)) {
      return "internal";
    }
  }
  return "external";
}

const EXPORT_DECLARATION_TYPES = [
  "function_declaration",
  "class_declaration",
  "lexical_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
];

function isBarrelFile(root: Node): boolean {
  let exportFromCount = 0;
  let otherStatements = 0;

  for (const child of root.children) {
    if (child.type === "export_statement") {
      const source = child.childForFieldName("source");
      if (source) {
        exportFromCount++;
      } else {
        otherStatements++;
      }
    } else if (child.isNamed && child.type !== "comment") {
      otherStatements++;
    }
  }

  return exportFromCount > 0 && otherStatements <= 1;
}

export class StructureExtractor implements StyleExtractor {
  readonly name = "structure";

  extract(file: ParsedFile): Observation[] {
    const observations: Observation[] = [];
    const root = file.tree.rootNode;

    this.extractImports(root, file, observations);
    this.extractExports(root, file, observations);
    this.detectBarrelFile(root, file, observations);

    return observations;
  }

  private extractImports(
    root: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    const groupSequence: string[] = [];

    for (const child of root.children) {
      const source = this.importSource(child, file.language);

      if (source) {
        const group = classifyImportSource(source, file.language);
        groupSequence.push(group);
        observations.push({
          type: "structure.import-group",
          category: "structure",
          value: group,
          file: file.filePath,
          line: child.startPosition.row + 1,
          metadata: { source },
        });
      }
    }

    this.addImportOrder(groupSequence, file, observations);
  }

  private addImportOrder(
    groupSequence: string[],
    file: ParsedFile,
    observations: Observation[],
  ): void {
    const uniqueOrder = [...new Set(groupSequence)];
    if (uniqueOrder.length > 0) {
      observations.push({
        type: "structure.import-order",
        category: "structure",
        value: JSON.stringify(uniqueOrder),
        file: file.filePath,
        line: 1,
        metadata: { groupCount: uniqueOrder.length },
      });
    }
  }

  private importSource(child: Node, language: string): string | null {
    let source: string | null = null;

    if (language === "python") {
      if (child.type === "import_statement") {
        const nameNode = child.childForFieldName("name");
        source = nameNode?.text ?? null;
      } else if (child.type === "import_from_statement") {
        const moduleNode = child.childForFieldName("module_name");
        const dots = child.children
          .filter((c) => c.type === "." || c.type === "relative_import")
          .map((c) => c.text)
          .join("");
        source = dots + (moduleNode?.text ?? "");
      }
    } else {
      if (child.type === "import_statement") {
        const sourceNode = child.childForFieldName("source");
        source = sourceNode?.text?.replace(/['"]/g, "") ?? null;
      }
    }

    return source;
  }

  private extractExports(
    root: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    if (file.language === "python") return;

    for (const child of root.children) {
      if (child.type === "export_statement") {
        this.processExport(child, file, observations);
      }
    }
  }

  private processExport(
    child: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    const isDefault = child.children.some((c) => c.type === "default");
    const style = isDefault ? "default" : "named";

    observations.push({
      type: "structure.export-style",
      category: "structure",
      value: style,
      file: file.filePath,
      line: child.startPosition.row + 1,
    });

    const proximity = this.exportProximity(child, isDefault);
    if (proximity) {
      observations.push({
        type: "structure.export-proximity",
        category: "structure",
        value: proximity,
        file: file.filePath,
        line: child.startPosition.row + 1,
      });
    }
  }

  private exportProximity(
    child: Node,
    isDefault: boolean,
  ): "inline" | "trailing" | null {
    const hasDeclaration = child.children.some((c) =>
      EXPORT_DECLARATION_TYPES.includes(c.type),
    );
    const isReExport = child.childForFieldName("source") !== null;

    if (hasDeclaration || isDefault) return "inline";
    if (!isReExport) return "trailing";
    return null;
  }

  private detectBarrelFile(
    root: Node,
    file: ParsedFile,
    observations: Observation[],
  ): void {
    if (file.language === "python") return;

    if (isBarrelFile(root)) {
      observations.push({
        type: "structure.barrel-file",
        category: "structure",
        value: true,
        file: file.filePath,
        line: 1,
      });
    }
  }
}
