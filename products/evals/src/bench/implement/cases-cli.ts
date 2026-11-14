import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { activeWorkRoot } from "@titan-design/app-paths";
import { Command, InvalidArgumentError } from "commander";
import { z } from "zod";
import { exportImplementTaskCases } from "../../implement-task/export.js";
import { defaultPolicy, type ExclusionPolicy } from "../../private/exclusion.js";
import { buildCorpus, stratifiedQueue, type Corpus, type ImplementCandidate } from "./corpus.js";
import { prepareBase } from "./prepare.js";
import { defaultFactoryDb, liveSources } from "./sources.js";

interface CasesFlags {
  out: string;
  prepared: string;
  factoryDb: string;
  tasksDir?: string;
  activeWorkRoot: string;
  repoDir: string;
  repoSlug: string;
  mainRef: string;
  mergedSince: string;
  seed: string;
  limit: number;
  dryRun?: boolean;
}

interface Context {
  flags: CasesFlags;
  policy: ExclusionPolicy;
  log: (line: string) => void;
}

const nonNegativeInt = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new InvalidArgumentError("expected a non-negative integer");
  return parsed;
};

function casesCommand(onFlags: (flags: CasesFlags) => void): Command {
  return new Command("implement-cases")
    .requiredOption("--out <dir>", "the cases dir: cases.jsonl, trees/<id>, hidden/<id>; outside every git work tree")
    .requiredOption("--prepared <dir>", "prepared bases, one <id> dir per kept case")
    .option("--factory-db <path>", "factory.sqlite3, opened read-only", defaultFactoryDb(process.env))
    .option("--tasks-dir <dir>", "task yml files (default: <active-work root>/titan-platform/tasks)")
    .option("--active-work-root <dir>", "where the private markers are read from", activeWorkRoot())
    .option("--repo-dir <dir>", "a clone holding the main ref", process.cwd())
    .option("--repo-slug <owner/repo>", "the registrations' repo", "HJewkes/titan-platform")
    .option("--main-ref <ref>", "the branch PRs squash onto", "origin/main")
    .option("--merged-since <date>", "earliest merge date kept", "2026-10-01")
    .option("--seed <text>", "seeds the stratified order", "bench-2026-11")
    .option("--limit <n>", "screen this many more candidates from the queue", nonNegativeInt, 0)
    .option("--dry-run", "write eligibility.json and the queue only")
    .exitOverride()
    .action((flags: CasesFlags) => onFlags(flags));
}

function countsOf(corpus: Corpus) {
  const skipped: Record<string, number> = {};
  for (const { reason } of corpus.skipped) skipped[reason] = (skipped[reason] ?? 0) + 1;
  const eligible: Record<string, number> = {};
  for (const { kind, size } of corpus.eligible) eligible[`${kind}/${size}`] = (eligible[`${kind}/${size}`] ?? 0) + 1;
  return { total: corpus.eligible.length, eligible, skipped };
}

function screenedIds(out: string): Set<string> {
  const file = join(out, "cases.jsonl");
  if (!existsSync(file)) return new Set();
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
  return new Set(lines.map((line) => ScreenedRow.parse(JSON.parse(line)).candidate));
}

const ScreenedRow = z.object({ candidate: z.string() });
const WrittenCase = z.object({ expected: z.object({ hiddenTests: z.array(z.object({ path: z.string() })) }) });

interface Exported {
  id?: string;
  reason: string;
  hiddenTests: string[];
}

function moveCase(exportDir: string, out: string): Exported {
  const [file] = readdirSync(join(exportDir, "cases"));
  if (file === undefined) return { reason: "export-wrote-no-case", hiddenTests: [] };
  const id = file.replace(/\.json$/, "");
  const body = WrittenCase.parse(JSON.parse(readFileSync(join(exportDir, "cases", file), "utf8")));
  for (const dir of ["trees", "hidden"]) {
    mkdirSync(join(out, dir), { recursive: true });
    rmSync(join(out, dir, id), { recursive: true, force: true });
    renameSync(join(exportDir, dir, id), join(out, dir, id));
  }
  return { id, reason: "keep", hiddenTests: body.expected.hiddenTests.map((test) => test.path) };
}

/** One candidate through the existing screen: a single-row corpus, so the queue's order, not the export's, decides what is screened. */
async function exportOne(candidate: ImplementCandidate, work: string, context: Context): Promise<Exported> {
  const corpus = join(work, "corpus.jsonl");
  writeFileSync(corpus, `${JSON.stringify(candidate.row)}\n`);
  const exportDir = join(work, "export");
  const { flags, policy, log } = context;
  const screenOptions = { classes: [candidate.kind], perClass: 1, seed: flags.seed, laterFixSource: "none" as const, log };
  const manifest = await exportImplementTaskCases({ corpus, outDir: exportDir, policy, cloneFor: () => flags.repoDir, ...screenOptions });
  if (manifest.counts[candidate.kind]?.kept === 1) return moveCase(exportDir, flags.out);
  const reason = manifest.dropped[0]?.reason ?? Object.keys({ ...manifest.skipped, ...manifest.excluded })[0] ?? "not-selected";
  return { reason, hiddenTests: [] };
}

async function prepareKept(id: string, candidate: ImplementCandidate, flags: CasesFlags): Promise<string> {
  const baseDir = join(flags.prepared, id);
  rmSync(baseDir, { recursive: true, force: true });
  mkdirSync(flags.prepared, { recursive: true });
  const prepared = await prepareBase({ baseDir, treeDir: join(flags.out, "trees", id), mergeSha: candidate.row.merge_commit });
  return prepared.verdict === "ready" ? "keep" : `${prepared.verdict}:${prepared.detail ?? ""}`;
}

const secondsSince = (started: number): number => Math.round((Date.now() - started) / 1000);

async function screenCandidate(candidate: ImplementCandidate, context: Context) {
  const work = join(context.flags.out, ".work", candidate.row.case_id);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const started = Date.now();
  try {
    const exported = await exportOne(candidate, work, context);
    const screenSeconds = secondsSince(started);
    const prepareStarted = Date.now();
    const reason = exported.id === undefined ? exported.reason : await prepareKept(exported.id, candidate, context.flags);
    return { exported, reason, screenSeconds, prepareSeconds: secondsSince(prepareStarted) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function caseRow(candidate: ImplementCandidate, result: Awaited<ReturnType<typeof screenCandidate>>) {
  const { row } = candidate;
  const { exported, reason, screenSeconds, prepareSeconds } = result;
  return {
    candidate: row.case_id,
    id: exported.id ?? null,
    taskId: candidate.taskId,
    pr: row.pr_number,
    kind: candidate.kind,
    size: candidate.size,
    pkg: candidate.pkg,
    pkgGroup: candidate.pkgGroup,
    mergeSha: row.merge_commit,
    baseSha: row.base_commit,
    brief: row.brief_text,
    hiddenTests: exported.hiddenTests,
    verdict: reason === "keep" ? "keep" : "drop",
    reason,
    nonTestLines: candidate.nonTestLines,
    changedLines: candidate.changedLines,
    screenSeconds,
    prepareSeconds,
  };
}

function writeQueue(out: string, corpus: Corpus, queue: readonly ImplementCandidate[]): void {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "eligibility.json"), `${JSON.stringify({ ...countsOf(corpus), skippedPrs: corpus.skipped }, null, 2)}\n`);
  const lines = queue.map(({ row, kind, size, pkgGroup }) => `${JSON.stringify({ candidate: row.case_id, kind, size, pkgGroup })}\n`);
  writeFileSync(join(out, "queue.jsonl"), lines.join(""));
}

async function run(flags: CasesFlags, log: (line: string) => void): Promise<void> {
  const tasksDir = flags.tasksDir ?? join(flags.activeWorkRoot, "titan-platform", "tasks");
  const sources = liveSources({ factoryDb: flags.factoryDb, repoSlug: flags.repoSlug, tasksDir, repoDir: flags.repoDir, mainRef: flags.mainRef });
  const corpus = await buildCorpus(sources, { mergedSince: flags.mergedSince, repo: flags.repoSlug.slice(flags.repoSlug.indexOf("/") + 1) });
  const queue = stratifiedQueue(corpus.eligible, flags.seed, (candidate) => candidate.row.case_id);
  writeQueue(flags.out, corpus, queue);
  log(JSON.stringify(countsOf(corpus)));
  if (flags.dryRun) return;
  const done = screenedIds(flags.out);
  const context: Context = { flags, policy: defaultPolicy(flags.activeWorkRoot), log };
  for (const candidate of queue.filter((entry) => !done.has(entry.row.case_id)).slice(0, flags.limit)) {
    const row = caseRow(candidate, await screenCandidate(candidate, context));
    appendFileSync(join(flags.out, "cases.jsonl"), `${JSON.stringify(row)}\n`);
    log(`${row.candidate} ${row.kind}/${row.size}/${row.pkgGroup}: ${row.reason} (screen ${row.screenSeconds}s, prepare ${row.prepareSeconds}s)`);
  }
}

/**
 * Builds the implement track's candidate queue and screens the next `--limit` candidates of it, one at a time.
 * Resumable: a candidate already in `cases.jsonl` is never screened again. Returns the process exit code.
 */
export async function runImplementCases(argv: readonly string[], log: (line: string) => void = (line) => process.stderr.write(`${line}\n`)): Promise<number> {
  let parsed: CasesFlags | undefined;
  try {
    casesCommand((flags) => (parsed = flags)).parse([...argv], { from: "user" });
    if (parsed === undefined) return 2;
    await run({ ...parsed, out: resolve(parsed.out), prepared: resolve(parsed.prepared), repoDir: resolve(parsed.repoDir) }, log);
    return 0;
  } catch (error) {
    log(`implement-cases: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
