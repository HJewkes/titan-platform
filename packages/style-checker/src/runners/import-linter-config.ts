import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ImportLinterConfig {
  path: string;
  /** Contract name to contract id; lint-imports prints names, the rule id wants the id. */
  contractIds: Map<string, string>;
}

// import-linter takes the id from the last colon-separated part of an importlinter: section name.
const INI_CONTRACT = /^\[importlinter:(?:.*:)?([^:\]]+)\]$/;

function iniContractIds(text: string): Map<string, string> {
  const ids = new Map<string, string>();
  let current: string | undefined;
  for (const line of text.split("\n").map((l) => l.trim())) {
    if (line.startsWith("[")) current = INI_CONTRACT.exec(line)?.[1];
    const name = current && /^name\s*[=:]\s*(.+)$/.exec(line);
    if (current && name) ids.set(name[1]!.trim(), current);
  }
  return ids;
}

function tomlValue(block: string, key: string): string | undefined {
  return new RegExp(`^${key}\\s*=\\s*["'](.+?)["']\\s*$`, "m").exec(block)?.[1];
}

function tomlContractIds(text: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const chunk of text.split(/^\[\[tool\.importlinter\.contracts\]\]\s*$/m).slice(1)) {
    const block = chunk.split(/^\[/m)[0]!;
    const name = tomlValue(block, "name");
    const id = tomlValue(block, "id");
    if (name && id) ids.set(name, id);
  }
  return ids;
}

function readIfContains(path: string, marker: RegExp): string | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf-8");
  return marker.test(text) ? text : undefined;
}

/** The config lint-imports would use, in its own lookup order: setup.cfg, .importlinter, then pyproject.toml. */
export function findImportLinterConfig(cwd: string): ImportLinterConfig | undefined {
  for (const name of ["setup.cfg", ".importlinter"]) {
    const ini = readIfContains(join(cwd, name), /^\[importlinter\]/m);
    if (ini !== undefined) return { path: join(cwd, name), contractIds: iniContractIds(ini) };
  }
  const toml = readIfContains(join(cwd, "pyproject.toml"), /^\[tool\.importlinter\]/m);
  if (toml !== undefined) return { path: join(cwd, "pyproject.toml"), contractIds: tomlContractIds(toml) };
  return undefined;
}
