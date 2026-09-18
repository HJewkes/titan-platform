import { readFile } from "node:fs/promises";
import type { StyleExtractor, ParsedFile, Observation } from "./types.js";
import {
  makeFormattingObs,
  parseEditorConfig,
  parsePrettierConfig,
} from "./formatting-config.js";

export class FormattingExtractor implements StyleExtractor {
  readonly name = "formatting";

  extract(file: ParsedFile): Observation[] {
    return this.extractFromSource(file.content, file.filePath);
  }

  async extractFromConfig(configPath: string): Promise<Observation[]> {
    try {
      const raw = await readFile(configPath, "utf-8");

      if (configPath.endsWith(".editorconfig")) {
        return parseEditorConfig(raw, configPath);
      }

      if (
        configPath.includes(".prettierrc") ||
        configPath.includes("prettier.config")
      ) {
        return parsePrettierConfig(raw, configPath);
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

    return [makeFormattingObs(
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

    return [makeFormattingObs(
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

    return [makeFormattingObs(
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

    return [makeFormattingObs(
      "formatting.braceStyle",
      nextLine / total > 0.5 ? "allman" : "1tbs",
      filePath, 1, "frequency",
    )];
  }

  private detectIndentation(
    lines: string[],
    filePath: string,
  ): Observation[] {
    const { tabCount, spaceCount, spaceSizes } = this.countIndentation(lines);

    const observations: Observation[] = [];
    const total = tabCount + spaceCount;
    if (total === 0) return observations;

    observations.push(makeFormattingObs(
      "formatting.indentStyle",
      tabCount > spaceCount ? "tab" : "space",
      filePath, 1, "frequency",
    ));

    if (spaceCount > tabCount && spaceSizes.length > 0) {
      const gcd = this.findGcdOfArray(spaceSizes.filter((s) => s > 0));
      observations.push(makeFormattingObs(
        "formatting.indentSize", gcd, filePath, 1, "frequency",
      ));
    }

    return observations;
  }

  private countIndentation(lines: string[]): {
    tabCount: number;
    spaceCount: number;
    spaceSizes: number[];
  } {
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

    return { tabCount, spaceCount, spaceSizes };
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
