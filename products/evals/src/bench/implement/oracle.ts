import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnExec, type Exec } from "@titan-design/fix-proof";
import { corepackHomeOf, loadImplementQueue, type ImplementCase } from "./job.js";
import { copyPreparedBase } from "./prepare.js";
import { scoreTree, type ImplementResult } from "./score.js";

const GIT_TIMEOUT_MS = 5 * 60_000;

interface OracleOptions {
  casesDir: string;
  preparedRoot: string;
  /** A clone holding every case's base and merge commits; only read. */
  repoDir: string;
  outDir: string;
  limit: number;
  seed: string;
  exec?: Exec;
  path: string;
  log: (line: string) => void;
}

type Side = "base" | "accepted";

interface OracleRow {
  caseId: string;
  side: Side;
  asExpected: boolean;
  seconds: number;
  result: ImplementResult | { error: string };
}

async function git(exec: Exec, dir: string, args: readonly string[]): Promise<string> {
  const result = await exec("git", ["-C", dir, ...args], { cwd: dir, timeoutMs: GIT_TIMEOUT_MS });
  if (result.status !== 0) throw new Error(`git ${args[0] ?? ""} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** The accepted merge's own diff, applied to a copy of the prepared base, stands in for an arm that did exactly that. */
async function applyAccepted(options: OracleOptions, exec: Exec, benchCase: ImplementCase, dir: string, ws: string): Promise<void> {
  const patch = await git(exec, options.repoDir, ["diff", "--binary", "--no-ext-diff", benchCase.baseSha, benchCase.mergeSha]);
  const patchPath = join(dir, "accepted.patch");
  writeFileSync(patchPath, patch);
  await git(exec, ws, ["apply", "--whitespace=nowarn", patchPath]);
}

async function scoreSide(options: OracleOptions, benchCase: ImplementCase, side: Side): Promise<ImplementResult> {
  const exec = options.exec ?? spawnExec;
  const dir = join(options.outDir, "oracle", benchCase.id, side);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const ws = join(dir, "ws");
  try {
    await copyPreparedBase(benchCase.id, ws, { preparedRoot: options.preparedRoot, exec });
    const rootSha = (await git(exec, ws, ["rev-parse", "HEAD"])).trim();
    if (side === "accepted") await applyAccepted(options, exec, benchCase, dir, ws);
    const hiddenDir = join(options.casesDir, "hidden", benchCase.id);
    const scoring = { exec, path: options.path, corepackHome: corepackHomeOf({}) };
    return await scoreTree({ benchCase, workspace: ws, workDir: join(dir, "score"), rootSha, hiddenDir, patchPath: join(dir, "scored.patch"), ...scoring });
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(join(dir, "score"), { recursive: true, force: true });
  }
}

/** The base must fail inside a vitest run that wrote its report; a harness error that ran nothing would read as a fail too. */
const expected = (side: Side, result: ImplementResult): boolean => (side === "base" ? result.hiddenFailed !== null && !result.hiddenPass && !result.solved : result.solved);

/**
 * The pilot gate's solvability check (design 9.4), with no model: each case's untouched base must fail its hidden
 * tests, and the base plus the accepted merge's diff must score solved, through the same scorer the arms get.
 */
export async function runOracle(options: OracleOptions): Promise<boolean> {
  const cases = loadImplementQueue(options.casesDir, options.seed).slice(0, options.limit);
  const ledger = join(options.outDir, "oracle.jsonl");
  mkdirSync(options.outDir, { recursive: true });
  let allExpected = true;
  for (const benchCase of cases) {
    for (const side of ["base", "accepted"] as const) {
      const started = Date.now();
      const result = await scoreSide(options, benchCase, side).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
      const asExpected = !("error" in result) && expected(side, result);
      const row: OracleRow = { caseId: benchCase.id, side, asExpected, seconds: Math.round((Date.now() - started) / 1000), result };
      appendFileSync(ledger, `${JSON.stringify(row)}\n`);
      options.log(`${benchCase.id} ${side}: ${asExpected ? "as expected" : "UNEXPECTED"} (${row.seconds}s)`);
      allExpected &&= asExpected;
    }
  }
  return allExpected;
}
