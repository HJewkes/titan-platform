import { existsSync } from "node:fs";
import { join } from "node:path";
import { findImportLinterConfig } from "./import-linter-config.js";
import type { ImportLinterConfig } from "./import-linter-config.js";
import { parseBrokenChains } from "./import-linter-output.js";
import type { BrokenChain } from "./import-linter-output.js";
import { auditRoot } from "./paths.js";
import { emptyResult, runPythonTool } from "./python-tool.js";
import type { AuditOptions, ParsedOutput, PythonToolSpec, ToolOutput } from "./python-tool.js";
import type { CheckDiagnostic } from "../orchestrator/types.js";
import type { RunnerResult } from "./types.js";

// lint-imports exits 1 when a contract is broken.
const IMPORT_LINTER: PythonToolSpec = {
  tool: "import-linter",
  command: "lint-imports",
  install: "pip install import-linter",
  expect: { successCodes: new Set([0, 1]) },
};

export const NO_IMPORT_LINTER_CONFIG = "no import-linter config";

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The importing module's source file, tried at the root and under src/. */
export function moduleFile(root: string, module: string): string | undefined {
  const base = module.replace(/\./g, "/");
  const candidates = ["", "src/"].flatMap((dir) => [`${dir}${base}.py`, `${dir}${base}/__init__.py`]);
  return candidates.find((c) => existsSync(join(root, c)));
}

function toDiagnostic(chain: BrokenChain, config: ImportLinterConfig, root: string): CheckDiagnostic {
  const first = chain.links[0]!;
  const file = moduleFile(root, first.importer);
  const path = [first.importer, ...chain.links.map((l) => l.imported)].join(" -> ");
  return {
    file: file ?? chain.contract,
    line: file ? (first.lines[0] ?? 1) : 1,
    column: 1,
    severity: "error",
    message: `${chain.summary}: ${path}`,
    category: "architecture",
    rule: `import-linter/${config.contractIds.get(chain.contract) ?? slug(chain.contract)}`,
    fixable: false,
  };
}

function parser(config: ImportLinterConfig, root: string): (output: ToolOutput) => ParsedOutput {
  return ({ stdout }) => {
    const chains = parseBrokenChains(stdout);
    if (chains.length === 0 && /\bBROKEN$/m.test(stdout)) throw new Error("lint-imports reported a broken contract but no import chain could be read");
    return { diagnostics: chains.map((c) => toDiagnostic(c, config, root)), failures: [] };
  };
}

/** One diagnostic per broken import chain; runs only when the project configures import-linter. */
export function runImportLinter(options?: AuditOptions): Promise<RunnerResult> {
  const root = auditRoot(options?.cwd);
  const config = findImportLinterConfig(root);
  if (!config) return Promise.resolve(emptyResult(null, { warnings: [NO_IMPORT_LINTER_CONFIG] }));
  const args = ["--config", config.path, "--no-logo", "--no-cache"];
  return runPythonTool(IMPORT_LINTER, args, options, parser(config, root));
}
