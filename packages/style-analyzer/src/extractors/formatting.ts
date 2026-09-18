import { readFile } from "node:fs/promises";
import type { StyleExtractor, ParsedFile, Observation } from "./types.js";

interface PrettierConfig {
  semi?: boolean;
  singleQuote?: boolean;
  trailingComma?: "none" | "es5" | "all";
  tabWidth?: number;
  useTabs?: boolean;
}

interface EditorConfigSection {
  indent_style?: "space" | "tab";
  indent_size?: string;
  insert_final_newline?: string;
}

export class FormattingExtractor implements StyleExtractor {
  readonly name = "formatting";

  extract(file: ParsedFile): Observation[] {
    return this.extractFromSource(file.content, file.filePath);
  }

  async extractFromConfig(configPath: string): Promise<Observation[]> {
    try {
      const raw = await readFile(configPath, "utf-8");

      if (configPath.endsWith(".editorconfig")) {
        return this.parseEditorConfig(raw, configPath);
      }

      if (
        configPath.includes(".prettierrc") ||
        configPath.includes("prettier.config")
      ) {
        return this.parsePrettierConfig(raw, configPath);
      }

      return [];
    } catch {
      return [];
    }
  }

  extractFromSource(source: string, filePath: string): Observation[] {
    const observations: Observation[] = [];
    const lines = source.split("\n");

    observations.push(...this.detectSemicolons(lines, filePath));
    observations.push(...this.detectQuoteStyle(source, filePath));
    observations.push(...this.detectTrailingCommas(source, filePath));
    observations.push(...this.detectBraceStyle(source, filePath));
    observations.push(...this.detectIndentation(lines, filePath));

    return observations;
  }

  private parsePrettierConfig(
    raw: string,
    configPath: string,
  ): Observation[] {
    const config: PrettierConfig = JSON.parse(raw);
    const observations: Observation[] = [];

    if (config.semi !== undefined) {
      observations.push(this.makeObs(
        "formatting.semicolons", config.semi, configPath, 1, "config",
      ));
    }

    if (config.singleQuote !== undefined) {
      observations.push(this.makeObs(
        "formatting.quoteStyle",
        config.singleQuote ? "single" : "double",
        configPath, 1, "config",
      ));
    }

    if (config.trailingComma !== undefined) {
      observations.push(this.makeObs(
        "formatting.trailingCommas",
        config.trailingComma !== "none",
        configPath, 1, "config",
      ));
    }

    if (config.tabWidth !== undefined) {
      observations.push(this.makeObs(
        "formatting.indentSize", config.tabWidth, configPath, 1, "config",
      ));
    }

    if (config.useTabs !== undefined) {
      observations.push(this.makeObs(
        "formatting.indentStyle",
        config.useTabs ? "tab" : "space",
        configPath, 1, "config",
      ));
    }

    return observations;
  }

  private parseEditorConfig(
    raw: string,
    configPath: string,
  ): Observation[] {
    const observations: Observation[] = [];
    const section = this.parseEditorConfigGlobal(raw);

    if (section.indent_style) {
      observations.push(this.makeObs(
        "formatting.indentStyle", section.indent_style, configPath, 1, "config",
      ));
    }

    if (section.indent_size) {
      observations.push(this.makeObs(
        "formatting.indentSize",
        parseInt(section.indent_size, 10),
        configPath, 1, "config",
      ));
    }

    if (section.insert_final_newline) {
      observations.push(this.makeObs(
        "formatting.trailingNewline",
        section.insert_final_newline === "true",
        configPath, 1, "config",
      ));
    }

    return observations;
  }

  private parseEditorConfigGlobal(raw: string): EditorConfigSection {
    const result: EditorConfigSection = {};
    const lines = raw.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || trimmed.startsWith("[") || !trimmed) {
        continue;
      }
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      if (key && value) {
        (result as Record<string, string>)[key] = value;
      }
    }

    return result;
  }

  private detectSemicolons(
    lines: string[],
    filePath: string,
  ): Observation[] {
    let withSemi = 0;
    let withoutSemi = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || this.isComment(trimmed)) continue;
      if (this.isStructuralLine(trimmed)) continue;

      if (trimmed.endsWith(";")) {
        withSemi++;
      } else if (this.isStatementStart(trimmed)) {
        withoutSemi++;
      }
    }

    const total = withSemi + withoutSemi;
    if (total === 0) return [];

    return [this.makeObs(
      "formatting.semicolons",
      withSemi / total > 0.5,
      filePath, 1, "frequency",
    )];
  }

  private detectQuoteStyle(
    source: string,
    filePath: string,
  ): Observation[] {
    let singleQuotes = 0;
    let doubleQuotes = 0;

    const stringPattern = /(?<!=)(?<!\\)(['"])((?:(?!\1|\\).|\\.)*)\1/g;
    let match: RegExpExecArray | null;

    while ((match = stringPattern.exec(source)) !== null) {
      if (match[1] === "'") {
        singleQuotes++;
      } else {
        doubleQuotes++;
      }
    }

    const total = singleQuotes + doubleQuotes;
    if (total === 0) return [];

    return [this.makeObs(
      "formatting.quoteStyle",
      singleQuotes > doubleQuotes ? "single" : "double",
      filePath, 1, "frequency",
    )];
  }

  private detectTrailingCommas(
    source: string,
    filePath: string,
  ): Observation[] {
    const trailingCommaPattern = /,\s*[\n\r]\s*[}\]]/g;
    const noTrailingPattern = /[^,\s]\s*[\n\r]\s*[}\]]/g;

    const trailing = (source.match(trailingCommaPattern) || []).length;
    const noTrailing = (source.match(noTrailingPattern) || []).length;
    const total = trailing + noTrailing;

    if (total === 0) return [];

    return [this.makeObs(
      "formatting.trailingCommas",
      trailing / total > 0.5,
      filePath, 1, "frequency",
    )];
  }

  private detectBraceStyle(
    source: string,
    filePath: string,
  ): Observation[] {
    const sameLine = (source.match(/\)[^\S\n]*\{/g) || []).length;
    const nextLine = (source.match(/\)\s*\n\s*\{/g) || []).length;

    const total = sameLine + nextLine;
    if (total === 0) return [];

    return [this.makeObs(
      "formatting.braceStyle",
      nextLine / total > 0.5 ? "allman" : "1tbs",
      filePath, 1, "frequency",
    )];
  }

  private detectIndentation(
    lines: string[],
    filePath: string,
  ): Observation[] {
    let tabCount = 0;
    let spaceCount = 0;
    const spaceSizes: number[] = [];

    for (const line of lines) {
      if (!line || line.trim() === "") continue;

      const leadingWhitespace = line.match(/^(\s+)/);
      if (!leadingWhitespace) continue;

      const ws = leadingWhitespace[1]!;

      if (ws.includes("\t")) {
        tabCount++;
      } else if (ws.length > 0) {
        spaceCount++;
        spaceSizes.push(ws.length);
      }
    }

    const observations: Observation[] = [];
    const total = tabCount + spaceCount;
    if (total === 0) return observations;

    observations.push(this.makeObs(
      "formatting.indentStyle",
      tabCount > spaceCount ? "tab" : "space",
      filePath, 1, "frequency",
    ));

    if (spaceCount > tabCount && spaceSizes.length > 0) {
      const gcd = this.findGcdOfArray(spaceSizes.filter((s) => s > 0));
      observations.push(this.makeObs(
        "formatting.indentSize", gcd, filePath, 1, "frequency",
      ));
    }

    return observations;
  }

  private isComment(trimmed: string): boolean {
    return (
      trimmed.startsWith("//") ||
      trimmed.startsWith("/*") ||
      trimmed.startsWith("*")
    );
  }

  private isStructuralLine(trimmed: string): boolean {
    return (
      trimmed.endsWith("{") ||
      trimmed.endsWith("}") ||
      trimmed.endsWith("(") ||
      trimmed.endsWith(",")
    );
  }

  private isStatementStart(trimmed: string): boolean {
    return (
      trimmed.startsWith("const ") ||
      trimmed.startsWith("let ") ||
      trimmed.startsWith("var ") ||
      trimmed.startsWith("return ") ||
      trimmed.startsWith("import ") ||
      trimmed.startsWith("export ")
    );
  }

  private makeObs(
    type: string,
    value: string | number | boolean,
    file: string,
    line: number,
    source: string,
  ): Observation {
    return {
      type,
      category: "formatting",
      value,
      file,
      line,
      metadata: { source },
    };
  }

  private findGcdOfArray(nums: number[]): number {
    if (nums.length === 0) return 2;
    return nums.reduce((a, b) => this.gcd(a, b));
  }

  private gcd(a: number, b: number): number {
    while (b) {
      [a, b] = [b, a % b];
    }
    return a;
  }
}
