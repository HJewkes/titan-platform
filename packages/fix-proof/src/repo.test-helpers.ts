import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gitIn, seedRepo } from "@titan-design/test-kit/git";
import { parseResultLine, type FixProofResult } from "./result-line.js";

export const VITEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../node_modules/vitest/vitest.mjs");
const BUGGY = "export const add = (a: number, b: number) => a - b;\n";
export const FIXED = "export const add = (a: number, b: number) => a + b;\n";
export const REAL_TEST = 'import { add } from "./math";\ntest("adds", () => expect(add(1, 2)).toBe(3));\n';
export const VACUOUS_TEST = 'import { add } from "./math";\ntest("adds zero", () => expect(add(0, 0)).toBe(0));\n';

/** This checkout's vitest, for a test that reads a verdict or what vitest reported. */
export const REAL_RUNNER = { command: `node ${VITEST} run --globals` };
// Writes an empty vitest JSON report to its --outputFile, so a side runs end to end without a nested vitest's startup.
const FAKE_RUNNER = `report() { while [ $# -gt 0 ] && [ "$1" != --outputFile ]; do shift; done; printf '{"testResults":[]}' > "$2"; }; report`;

export interface Repo {
  dir: string;
  base: string;
  commit(files: Record<string, string>): string;
}

export function git(dir: string, args: string[]): string {
  return gitIn(dir)(...args);
}

/**
 * A git repo whose base commit holds the buggy module, `files` and a fix-proof config whose runner only writes an empty
 * report; pass REAL_RUNNER for a real vitest. Removed by removeRepos.
 */
export function makeRepo(config: Record<string, string> = {}, parent: string = os.tmpdir(), files: Record<string, string> = {}): Repo {
  const dir = fs.mkdtempSync(path.join(parent, "fix-proof-run-"));
  repos.push(dir);
  const fixProofConfig = { command: FAKE_RUNNER, build: "true", ...config };
  // Configs repeat across a file and files rarely do, so only the config keys a template; files land in a second commit.
  seedRepo(dir, { "src/math.ts": BUGGY, ".github/fix-proof.json": JSON.stringify(fixProofConfig) });
  const commit = (changes: Record<string, string>) => {
    for (const [file, text] of Object.entries(changes)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "change"]);
    return git(dir, ["rev-parse", "HEAD"]);
  };
  const base = Object.keys(files).length === 0 ? git(dir, ["rev-parse", "HEAD"]) : commit(files);
  return { dir, base, commit };
}

const repos: string[] = [];

export function removeRepos(): void {
  repos.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
}

export function parsed(line: string): FixProofResult {
  const result = parseResultLine(line);
  if (!result.ok) throw new Error(result.error);
  return result.result;
}
