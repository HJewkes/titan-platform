import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * TP-2436: serve shares one event loop with workflow lease renewal, so a sync child that outlives leaseMs/3 costs every
 * running run its lease (TP-2433). Only the CLI may block; serve code reaches agent-chat and other children async.
 */
const BANNED: Record<string, readonly string[]> = {
  "@titan-design/agent-dispatch": ["execSafe"],
  "node:child_process": ["execFileSync", "execSync", "spawnSync"],
  child_process: ["execFileSync", "execSync", "spawnSync"],
};

const ALLOWED: Record<string, string> = {
  "review/gh-line-source.ts": "gh, not agent-chat; evidence's LineSource is sync, and only the review CLI reads it",
  "shepherd/spawn-gate.ts": "sysctl, not agent-chat; answers in ms",
};

const IMPORT = /import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g;

function importedNames(clause: string): string[] {
  if (/^\*\s+as\s/.test(clause)) return ["*"];
  const braces = /\{([^}]*)\}/.exec(clause)?.[1];
  if (braces === undefined) return [];
  return braces
    .split(",")
    .map((specifier) => specifier.trim())
    .filter((specifier) => specifier !== "" && !specifier.startsWith("type "))
    .map((specifier) => specifier.split(/\s+as\s+/)[0] ?? specifier);
}

/** Pure: each banned sync import in one source file, as `<module>:<name>`; a child_process namespace import counts. */
function syncExecImports(source: string): string[] {
  const found: string[] = [];
  for (const [, typeOnly, clause = "", module = ""] of source.matchAll(IMPORT)) {
    const banned = BANNED[module];
    if (banned === undefined || typeOnly !== undefined) continue;
    for (const name of importedNames(clause)) {
      if (banned.includes(name) || (name === "*" && module.endsWith("child_process"))) found.push(`${module}:${name}`);
    }
  }
  return found;
}

/** Pure: whether a src-relative path is CLI or test code, where a sync child cannot stall serve. */
function exempt(path: string): boolean {
  const name = basename(path);
  if (name.endsWith(".test.ts") || path.split("/").includes("test-support")) return true;
  return name === "cli.ts" || name === "bin.ts" || /^cli-.*\.ts$/.test(name);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

const SRC = fileURLToPath(new URL(".", import.meta.url));

describe("syncExecImports", () => {
  it("flags execSafe from agent-dispatch", () => {
    expect(syncExecImports('import { DispatchError, execSafe } from "@titan-design/agent-dispatch";')).toEqual(["@titan-design/agent-dispatch:execSafe"]);
  });

  it("flags a sync child_process import written across lines", () => {
    const source = 'import {\n  execFile,\n  execFileSync,\n} from "node:child_process";\nimport { spawnSync as run } from "child_process";';

    expect(syncExecImports(source)).toEqual(["node:child_process:execFileSync", "child_process:spawnSync"]);
  });

  it("flags a child_process namespace import, which reaches the sync calls", () => {
    expect(syncExecImports('import * as cp from "node:child_process";')).toEqual(["node:child_process:*"]);
  });

  it("ignores type-only imports and the async calls", () => {
    const source = [
      'import type { execSafe } from "@titan-design/agent-dispatch";',
      'import { type execSafe as Sync, execSafeAsync } from "@titan-design/agent-dispatch";',
      'import { execFile, spawn } from "node:child_process";',
    ].join("\n");

    expect(syncExecImports(source)).toEqual([]);
  });
});

describe("exempt", () => {
  it("exempts the CLI, bin and tests, and nothing else", () => {
    const exempted = ["cli.ts", "cli-shepherd.ts", "bin.ts", "serve.test.ts", "test-support/git-line.ts", "shepherd/cli-x.ts"];
    const scanned = ["serve.ts", "client.ts", "shepherd/spawn-gate.ts", "clients.ts"];

    expect(exempted.filter(exempt)).toEqual(exempted);
    expect(scanned.filter(exempt)).toEqual([]);
  });
});

describe("factory serve code", () => {
  it("imports no sync exec outside the CLI, bin, tests and the allowlist", () => {
    const offenders = sourceFiles(SRC)
      .map((path) => relative(SRC, path).split(sep).join("/"))
      .filter((path) => !exempt(path))
      .flatMap((path) => syncExecImports(readFileSync(join(SRC, path), "utf8")).map((hit) => `${path} ${hit}`));

    const offendingFiles = offenders.map((offender) => offender.slice(0, offender.indexOf(" ")));

    expect(offenders.filter((_, i) => !Object.hasOwn(ALLOWED, offendingFiles[i] ?? ""))).toEqual([]);
    expect(offendingFiles).toEqual(Object.keys(ALLOWED));
  });
});
