import type { CheckDiagnostic } from "../orchestrator/types.js";

const RUFF_CODE_CATEGORY: Record<string, string> = {
  N: "naming",
  I: "imports",
  D: "documentation",
  C: "complexity",
  E: "formatting",
  W: "formatting",
  F: "errors",
};

const ESLINT_RULE_CATEGORY: Record<string, string> = {
  "@typescript-eslint/naming-convention": "naming",
  "unicorn/filename-case": "naming",
  "perfectionist/sort-imports": "imports",
  "import/order": "imports",
  "max-lines-per-function": "structure",
  "max-depth": "structure",
  "jsdoc/require-jsdoc": "documentation",
};

function eslintSeverityToSeverity(eslintSeverity: number): "error" | "warn" {
  return eslintSeverity === 2 ? "error" : "warn";
}

function categorizeEslintRule(ruleId: string): string {
  if (ESLINT_RULE_CATEGORY[ruleId]) return ESLINT_RULE_CATEGORY[ruleId];
  if (ruleId.startsWith("@typescript-eslint/")) return "typescript";
  if (ruleId.startsWith("jsdoc/")) return "documentation";
  if (ruleId.startsWith("unicorn/")) return "style";
  if (ruleId.startsWith("import/")) return "imports";
  return "other";
}

function categorizeRuffCode(code: string): string {
  const prefix = code.replace(/[0-9]/g, "");
  return RUFF_CODE_CATEGORY[prefix] ?? "other";
}

interface EslintJsonEntry {
  filePath: string;
  messages: Array<{
    ruleId: string | null;
    severity: number;
    message: string;
    line: number;
    column: number;
    fix?: { range: [number, number]; text: string } | null;
  }>;
}

interface RuffJsonEntry {
  code: string;
  message: string;
  filename: string;
  location: { row: number; column: number };
  end_location: { row: number; column: number };
  fix?: {
    edits: Array<{
      content: string;
      location: { row: number; column: number };
      end_location: { row: number; column: number };
    }>;
  } | null;
}

export function parseEslintJsonOutput(jsonStr: string): CheckDiagnostic[] {
  let entries: EslintJsonEntry[];
  try {
    entries = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      `Failed to parse ESLint JSON output. Raw output:\n${jsonStr.slice(0, 500)}`,
    );
  }
  const diagnostics: CheckDiagnostic[] = [];

  for (const entry of entries) {
    for (const msg of entry.messages) {
      if (!msg.ruleId) continue;
      diagnostics.push({
        file: entry.filePath,
        line: msg.line,
        column: msg.column,
        severity: eslintSeverityToSeverity(msg.severity),
        message: msg.message,
        category: categorizeEslintRule(msg.ruleId),
        rule: msg.ruleId,
        fixable: msg.fix != null,
        fix: msg.fix ?? undefined,
      });
    }
  }

  return diagnostics;
}

export function parseRuffJsonOutput(jsonStr: string): CheckDiagnostic[] {
  let entries: RuffJsonEntry[];
  try {
    entries = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      `Failed to parse Ruff JSON output. Raw output:\n${jsonStr.slice(0, 500)}`,
    );
  }
  return entries.map((entry) => ({
    file: entry.filename,
    line: entry.location.row,
    column: entry.location.column,
    severity: "warn" as const,
    message: entry.message,
    category: categorizeRuffCode(entry.code),
    rule: entry.code,
    fixable: entry.fix != null,
  }));
}

export function formatDiagnostic(d: CheckDiagnostic): string {
  return `${d.file}:${d.line}:${d.column} ${d.severity} ${d.message} [${d.category}.${d.rule}]`;
}
