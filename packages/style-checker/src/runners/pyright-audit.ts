import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_PYRIGHT_RULES, generatePyrightAuditConfig } from "../generators/pyright-audit.js";
import { auditRoot } from "./paths.js";
import { runPythonTool } from "./python-tool.js";
import type { AuditOptions, ParsedOutput, PythonToolSpec, ToolOutput } from "./python-tool.js";
import type { CheckDiagnostic, ToolFailure } from "../orchestrator/types.js";
import type { RunnerResult } from "./types.js";

const PYRIGHT: PythonToolSpec = {
  tool: "pyright",
  command: "pyright",
  install: "pip install pyright",
  installNote: "the pip wrapper fetches pyright's npm package on first run and needs Node on PATH; `npm install -g pyright` also works",
  expect: { successCodes: new Set([0, 1]) },
};

interface PyrightDiagnostic {
  file: string;
  severity: string;
  message: string;
  rule?: string;
  range: { start: { line: number; character: number }; end: { line: number } };
}

export interface PyrightOptions extends AuditOptions {
  /** The interpreter whose site-packages pyright resolves third-party imports from. */
  pythonPath?: string;
}

function toDiagnostic(d: PyrightDiagnostic & { rule: string }): CheckDiagnostic {
  return {
    file: d.file,
    line: d.range.start.line + 1,
    endLine: d.range.end.line + 1,
    column: d.range.start.character + 1,
    severity: "warn",
    message: d.message,
    category: "redundant-check",
    rule: `pyright/${d.rule}`,
    fixable: false,
  };
}

// A diagnostic without a rule is a syntax error; the file is reported once, as ruff's runner does.
function unparsedFiles(entries: PyrightDiagnostic[]): ToolFailure[] {
  const byFile = new Map<string, string[]>();
  for (const e of entries.filter((d) => !d.rule && d.severity === "error")) {
    byFile.set(e.file, [...(byFile.get(e.file) ?? []), e.message]);
  }
  return [...byFile].map(([file, messages]) => ({ tool: "pyright", kind: "file-not-checked", file, message: messages.join("; ") }));
}

export function parsePyrightOutput({ stdout }: ToolOutput): ParsedOutput {
  const entries = (JSON.parse(stdout) as { generalDiagnostics: PyrightDiagnostic[] }).generalDiagnostics;
  const audited = entries.filter((d): d is PyrightDiagnostic & { rule: string } => AUDIT_PYRIGHT_RULES.includes(d.rule ?? ""));
  return { diagnostics: audited.map(toDiagnostic), failures: unparsedFiles(entries) };
}

/** Redundant isinstance, comparison, contains and cast findings from pyright; rule ids are pyright/<rule>. */
export async function runPyrightAudit(files: string[], options?: PyrightOptions): Promise<RunnerResult> {
  const tempDir = mkdtempSync(join(tmpdir(), "style-checker-pyright-"));
  try {
    const configPath = join(tempDir, "pyrightconfig.json");
    writeFileSync(configPath, JSON.stringify(generatePyrightAuditConfig(auditRoot(options?.cwd))), "utf-8");
    const python = options?.pythonPath ? ["--pythonpath", options.pythonPath] : [];
    return await runPythonTool(PYRIGHT, ["--outputjson", "-p", configPath, ...python, ...files], options, parsePyrightOutput);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
