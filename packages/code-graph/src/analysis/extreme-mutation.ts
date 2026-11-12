import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  compileGlobs,
  CONFIG_PATH,
  execHeadMutants,
  parseFixProofConfig,
  type Exec,
  type HeadMutantsReport,
} from "@titan-design/fix-proof";
import type { Finding } from "../check/findings.js";
import type { CodeGraphStore } from "../store.js";
import type { GraphEdge, GraphNode } from "../types.js";
import { planBodyDeletes } from "./body-delete.js";
import { coveredFunctionStarts, type IstanbulCoverage } from "./coverage.js";
import { extremeFindings, type ExtremeSummary } from "./pseudo-tested.js";
import { fileTestReach } from "./test-reach.js";

const run = promisify(execFile);
const TS_SOURCE = /\.(?:ts|tsx|mts|cts)$/;

export interface ExtremeMutationOptions {
  /** The git toplevel. */
  repo: string;
  head: string;
  /** Repo path → head-side inclusive line ranges from `-U0` hunks. */
  changed: ReadonlyMap<string, readonly (readonly [number, number])[]>;
  /** A whole-suite Istanbul `coverage-final.json` and the commit it was measured at, which must be `head`. */
  coverage: { head: string; data: IstanbulCoverage };
  /** A snapshot at head, read only for its import and mocks edges. */
  store: Pick<CodeGraphStore, "listEdges">;
  snapshotId: number;
  max?: number;
  budgetMs?: number;
  sandboxUser?: string;
  exec?: Exec;
}

export interface ExtremeMutationResult {
  findings: Finding[];
  summary: ExtremeSummary;
  report: HeadMutantsReport;
}

async function git(repo: string, args: string[]): Promise<string> {
  return (await run("git", args, { cwd: repo, maxBuffer: 256 * 1024 * 1024, encoding: "utf-8" })).stdout;
}

async function resolveSha(repo: string, ref: string): Promise<string> {
  return (await git(repo, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}

/** Head text of each changed TS source that still exists at head. */
async function headSources(repo: string, head: string, paths: readonly string[]): Promise<Map<string, string>> {
  const present = new Set((await git(repo, ["ls-tree", "-r", "--name-only", head])).split("\n"));
  const wanted = paths.filter((file) => TS_SOURCE.test(file) && !file.endsWith(".d.ts") && present.has(file));
  return new Map(await Promise.all(wanted.map(async (file) => [file, await git(repo, ["show", `${head}:${file}`])] as const)));
}

async function testFilesAt(repo: string, head: string): Promise<string[]> {
  const listed = (await git(repo, ["ls-tree", "--name-only", head, "--", CONFIG_PATH])).trim();
  const parsed = parseFixProofConfig(listed === "" ? null : await git(repo, ["show", `${head}:${CONFIG_PATH}`]));
  if (!parsed.ok) throw new Error(parsed.error);
  const isTest = compileGlobs(parsed.config.tests);
  return (await git(repo, ["ls-tree", "-r", "--name-only", head])).split("\n").filter((file) => file !== "" && isTest(file));
}

/** Maps a coverage path into the repo, through the repo's real path too, since a coverage run may name either. */
function repoPathOf(repo: string): (abs: string) => string | null {
  const roots = [...new Set([path.resolve(repo), fs.realpathSync(repo)])];
  return (abs) => {
    for (const root of roots) {
      const relative = path.relative(root, abs);
      if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) && !relative.split(path.sep).includes("node_modules")) {
        return relative.split(path.sep).join("/");
      }
    }
    return null;
  };
}

/**
 * Files each test file loads at runtime, transitively, memoised per test (TP-4950). A module the test's own
 * `vi.mock` replaces is not reached through that hop, so a mocked module does not count as tested by it.
 */
function testReach(testFiles: readonly string[], edges: readonly GraphEdge[]): (testFile: string) => ReadonlySet<string> {
  const nodes = testFiles.map((id): GraphNode => ({ id, kind: "file", name: path.posix.basename(id), role: "test" }));
  const { tests, reaching } = fileTestReach(nodes, edges);
  const bitOf = new Map(tests.map((id, i) => [id, i]));
  const memo = new Map<string, Set<string>>();
  return (testFile) => {
    const reached = memo.get(testFile) ?? reachedBy(reaching, testFile, bitOf.get(testFile));
    memo.set(testFile, reached);
    return reached;
  };
}

function reachedBy(reaching: ReadonlyMap<string, Uint32Array>, testFile: string, bit: number | undefined): Set<string> {
  const out = new Set<string>();
  if (bit === undefined) return out;
  for (const [id, bits] of reaching) {
    if (id !== testFile && (bits[bit >>> 5]! & (1 << (bit & 31))) !== 0) out.add(id);
  }
  return out;
}

function emptyReport(head: string): HeadMutantsReport {
  return { head, suites: {}, baseline: [], runs: [], unrun: [], wallMs: 0, builds: 0 };
}

/**
 * Body-deletes each changed, covered function at head, runs its owning package's tests against it in fix-proof's throwaway
 * worktree, and reads the outcomes as findings. Nothing outside that worktree is written. Throws only when the coverage was
 * not measured at head or the head's fix-proof config does not parse.
 */
export async function runExtremeMutation(o: ExtremeMutationOptions): Promise<ExtremeMutationResult> {
  const head = await resolveSha(o.repo, o.head);
  const measuredAt = await resolveSha(o.repo, o.coverage.head).catch(() => o.coverage.head);
  if (measuredAt !== head) throw new Error(`extreme mutation: coverage was measured at ${o.coverage.head}, not at head ${head}`);
  const files = await headSources(o.repo, head, [...o.changed.keys()]);
  const covered = coveredFunctionStarts(o.coverage.data, repoPathOf(o.repo));
  const plan = planBodyDeletes({ files, changed: o.changed, covered, max: o.max, seed: head });
  const testFiles = await testFilesAt(o.repo, head);
  const mutations = plan.targets.map((target) => target.mutation);
  const report =
    mutations.length === 0
      ? emptyReport(head)
      : await execHeadMutants({ repo: o.repo, head, mutations, budgetMs: o.budgetMs, sandboxUser: o.sandboxUser, exec: o.exec });
  const reachedFiles = testReach(testFiles, o.store.listEdges(o.snapshotId));
  return { ...extremeFindings({ plan, report, reachedFiles, testFiles }), report };
}
