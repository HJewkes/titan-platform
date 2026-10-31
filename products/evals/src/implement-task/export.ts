import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { caseHash, sha256Hex, suiteHash } from "../hash.js";
import { filterPrivate, type ExclusionPolicy } from "../private/exclusion.js";
import { assertFreshOut, assertOutsideWorkTree } from "../private/out-dir.js";
import { localCloneGit, type BundleGit } from "../review-pr/bundle.js";
import { SuiteSpecSchema, type EvalCase, type SuiteSpec } from "../spec/index.js";
import { cloneFacts } from "./clone-facts.js";
import { screenCase } from "./screen.js";
import { briefOf, parseCorpusV3, selectCandidates, type CandidateFacts, type CorpusV3Row, type TestChange } from "./select.js";
import { IMPLEMENT_TASK_UNIT, planHiddenTests, writeImplementTaskCases, type ImplementTaskSource } from "./write-case.js";

// The corpus names repos bare; the screen and the case's input need owner/name.
const DEFAULT_OWNER = "HJewkes";

export interface ExportOptions {
  /** Path to `cases.v3.classified.jsonl`; its sha256 goes in the manifest. */
  corpus: string;
  outDir: string;
  policy: ExclusionPolicy;
  /** The local clone for `owner/repo`. An allowlisted repo with none is left out and named in `reposWithoutClone`. */
  cloneFor(repo: string): string | undefined;
  /** Prefixes a bare corpus repo name; defaults to the engineering repos' owner. */
  owner?: string;
  classes: readonly string[];
  perClass: number;
  seed: string;
  /** Caps each class's pool after filtering, so an operator's first run screens a known few. */
  maxCandidates?: number;
  /** Replaces `screenCase`; returns `keep` or a drop reason. */
  screen?: (source: ImplementTaskSource) => Promise<string>;
  /** Progress lines; stderr unless replaced. */
  log?: (line: string) => void;
}

type Dropped = { repo: string; pr: number; cls: string; reason: string };
type Candidate = CorpusV3Row & { source: ImplementTaskSource; failure: string | undefined };

interface ExportPool {
  byClass: Record<string, ImplementTaskSource[]>;
  /** Candidates whose facts or plan could not be read: lost to one old commit, not to the run. */
  dropped: Dropped[];
  /** Counts by reason: a skipped row may belong to a private repo, so its id stays out of the manifest. */
  skipped: Record<string, number>;
  excluded: Record<string, number>;
  reposWithoutClone: string[];
  laterFixPrs: Record<string, number[]>;
  corpusSha256: string;
}

interface ClassCount {
  kept: number;
  screened: number;
  /** Candidates that were never screened because the quota filled first. */
  unscreened: number;
  shortfall: number;
}

interface ExportManifest {
  schema: "titan.implement-task-cases/v1";
  corpusSha256: string;
  seed: string;
  perClass: number;
  counts: Record<string, ClassCount>;
  skipped: Record<string, number>;
  dropped: Dropped[];
  excluded: Record<string, number>;
  reposWithoutClone: string[];
  /** Keyed `repo#pr`, listed and not screened: their tests are not in this round's hidden set. */
  laterFixPrs: Record<string, number[]>;
  suite: string;
}

const prKey = (source: ImplementTaskSource): string => `${source.repo}#${source.pr}`;
const qualified = (options: Pick<ExportOptions, "owner">, repo: string): string => (repo.includes("/") ? repo : `${options.owner ?? DEFAULT_OWNER}/${repo}`);
const screenError = (error: unknown): string => `screen-error:${error instanceof Error ? error.message : String(error)}`;

function sourceOf(row: CorpusV3Row, options: Pick<ExportOptions, "owner">): ImplementTaskSource {
  const commits = { baseSha: row.base_commit, mergeSha: row.merge_commit };
  return { repo: qualified(options, row.repo), pr: row.pr_number, ...commits, brief: briefOf(row), taskInitiative: row.task?.initiative ?? null, cls: row.class };
}

function countBy<T extends string>(reasons: readonly T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  return counts;
}

function portFor(options: Pick<ExportOptions, "cloneFor" | "owner">, repo: string): BundleGit | undefined {
  const clone = options.cloneFor(qualified(options, repo));
  return clone === undefined ? undefined : localCloneGit(clone);
}

function requirePort(options: Pick<ExportOptions, "cloneFor" | "owner">, repo: string): BundleGit {
  const port = portFor(options, repo);
  if (port === undefined) throw new Error(`no local clone for ${repo}`);
  return port;
}

/** Records a row's failed fact and answers so the selector keeps the row, since it has no skip reason for a failure and aborts on a throw. */
function recordingFailures(facts: CandidateFacts, failures: Map<string, string>): CandidateFacts {
  const guard = <T>(ask: (row: CorpusV3Row) => Promise<T>, whenFailed: T) => async (row: CorpusV3Row): Promise<T> => {
    try {
      return await ask(row);
    } catch (error) {
      failures.set(row.case_id, screenError(error));
      return whenFailed;
    }
  };
  return {
    hasSupportedLock: guard((row) => facts.hasSupportedLock(row), true),
    mergeParents: guard((row) => facts.mergeParents(row), 1),
    testChange: guard<TestChange>((row) => facts.testChange(row), "tests-and-source"),
  };
}

async function planOrFailure(source: ImplementTaskSource, row: CorpusV3Row, options: ExportOptions) {
  try {
    return { plan: await planHiddenTests(requirePort(options, row.repo), source.baseSha, source.mergeSha), failure: undefined };
  } catch (error) {
    return { plan: undefined, failure: screenError(error) };
  }
}

/** The body holds the plan as well as the brief, so a private task id in a test path drops here, ahead of a long screen, and not as the writer's refusal after it. A failed row is still filtered, so a private one is counted and never listed. */
async function filterCandidates(rows: readonly CorpusV3Row[], failures: ReadonlyMap<string, string>, options: ExportOptions) {
  const subjects = [];
  for (const row of rows) {
    const source = sourceOf(row, options);
    const known = failures.get(row.case_id);
    const { plan, failure } = known === undefined ? await planOrFailure(source, row, options) : { plan: undefined, failure: known };
    const candidate: Candidate = { ...row, source, failure };
    subjects.push({ id: row.case_id, repo: source.repo, taskInitiative: source.taskInitiative, body: { source, plan }, candidate });
  }
  const { kept, excluded } = filterPrivate(subjects, options.policy);
  const candidates = kept.map((subject) => subject.candidate);
  const dropped = candidates.flatMap(({ source, failure }) => (failure === undefined ? [] : [{ repo: source.repo, pr: source.pr, cls: source.cls, reason: failure }]));
  return { kept: candidates.filter((row) => row.failure === undefined), dropped, excluded: { ...excluded } };
}

/** Everything short of a build: selection, private filtering and the corpus digest. Runs no install, build or test. */
export async function selectExportPool(options: ExportOptions): Promise<ExportPool> {
  const text = readFileSync(options.corpus);
  const reposWithoutClone = options.policy.repos.filter((repo) => portFor(options, repo) === undefined);
  const repos = options.policy.repos.filter((repo) => !reposWithoutClone.includes(repo));
  const failures = new Map<string, string>();
  const facts = recordingFailures(cloneFacts((row) => requirePort(options, row.repo)), failures);
  const selection = await selectCandidates(parseCorpusV3(text.toString("utf8")), { repos, classes: options.classes, seed: options.seed }, facts);
  const { kept, dropped, excluded } = await filterCandidates(Object.values(selection.byClass).flat(), failures, options);
  const byClass: ExportPool["byClass"] = {};
  for (const cls of options.classes) {
    byClass[cls] = kept.filter((row) => row.class === cls).slice(0, options.maxCandidates).map((row) => row.source);
  }
  const later = kept.filter((row) => row.follow_up_fixes.length > 0).map((row) => [prKey(row.source), row.follow_up_fixes] as const);
  return { byClass, dropped, skipped: countBy(selection.skipped.map((skip) => skip.reason)), excluded, reposWithoutClone, laterFixPrs: Object.fromEntries(later), corpusSha256: sha256Hex(text) };
}

interface Screened {
  kept: ImplementTaskSource[];
  counts: Record<string, ClassCount>;
  dropped: ExportManifest["dropped"];
}

async function verdictOf(screen: NonNullable<ExportOptions["screen"]>, source: ImplementTaskSource): Promise<string> {
  try {
    return await screen(source);
  } catch (error) {
    return screenError(error);
  }
}

/** One at a time and one class at a time: a screen is two installs and two builds, and stopping at quota is the point. */
async function screenToQuota(pool: ExportPool, options: ExportOptions, screen: NonNullable<ExportOptions["screen"]>, log: NonNullable<ExportOptions["log"]>): Promise<Screened> {
  const result: Screened = { kept: [], counts: {}, dropped: [] };
  for (const [cls, candidates] of Object.entries(pool.byClass)) {
    let kept = 0;
    let screened = 0;
    for (const source of candidates) {
      if (kept >= options.perClass) break;
      const started = Date.now();
      const verdict = await verdictOf(screen, source);
      screened += 1;
      log(`${prKey(source)} ${cls}: ${verdict} (${Math.round((Date.now() - started) / 1000)}s)`);
      if (verdict === "keep") {
        kept += 1;
        result.kept.push(source);
      } else {
        result.dropped.push({ repo: source.repo, pr: source.pr, cls, reason: verdict });
      }
    }
    result.counts[cls] = { kept, screened, unscreened: candidates.length - screened, shortfall: Math.max(0, options.perClass - kept) };
  }
  return result;
}

function suiteOf(cases: readonly EvalCase[]): SuiteSpec {
  return SuiteSpecSchema.parse({
    schema: "titan.suite/v1",
    unit: IMPLEMENT_TASK_UNIT,
    id: "implement-task-private",
    version: "1.0.0",
    cases: cases.map(caseHash).sort(),
    // Hidden-test grading is TP-420's to define; an invented check here would pre-empt it.
    checks: [],
    trials: 3,
  });
}

function writeJson(outDir: string, name: string, value: unknown): void {
  writeFileSync(join(outDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function mergeCounts(first: Record<string, number>, second: Record<string, number>): Record<string, number> {
  const merged = { ...first };
  for (const [reason, count] of Object.entries(second)) merged[reason] = (merged[reason] ?? 0) + count;
  return merged;
}

async function writeOutput(pool: ExportPool, screened: Screened, options: ExportOptions): Promise<ExportManifest> {
  const gitFor = (repo: string) => portFor(options, repo);
  const { cases, excluded } = await writeImplementTaskCases(screened.kept, { outDir: options.outDir, policy: options.policy, gitFor, seed: options.seed });
  const suite = suiteOf(cases);
  const { corpusSha256, skipped, reposWithoutClone, laterFixPrs } = pool;
  const manifest: ExportManifest = {
    schema: "titan.implement-task-cases/v1",
    corpusSha256,
    seed: options.seed,
    perClass: options.perClass,
    counts: screened.counts,
    skipped,
    dropped: [...pool.dropped, ...screened.dropped],
    excluded: mergeCounts(pool.excluded, excluded),
    reposWithoutClone,
    laterFixPrs,
    suite: suiteHash(suite),
  };
  mkdirSync(options.outDir, { recursive: true });
  writeJson(options.outDir, "suite.json", suite);
  writeJson(options.outDir, "manifest.json", manifest);
  return manifest;
}

/**
 * Selects candidates, filters private ones, screens each class in seeded order until its quota fills or its pool
 * ends, and only then writes the kept cases, `suite.json` and `manifest.json`. A case is never written unscreened,
 * and `.scratch` goes even on a throw, so no clone sits beside the private cases.
 */
export async function exportImplementTaskCases(options: ExportOptions): Promise<ExportManifest> {
  await assertOutsideWorkTree(options.outDir);
  assertFreshOut(options.outDir);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const screen = options.screen ?? ((source: ImplementTaskSource) => screenCase(source, { outDir: options.outDir, cloneFor: options.cloneFor }));
  try {
    const pool = await selectExportPool(options);
    const screened = await screenToQuota(pool, options, screen, log);
    return await writeOutput(pool, screened, options);
  } finally {
    rmSync(join(options.outDir, ".scratch"), { recursive: true, force: true, maxRetries: 3 });
  }
}
