import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MainCommit } from "../corpus/git.js";
import { canonicalJson, sha256Hex } from "../hash.js";
import { assertNoPrivate, filterPrivate, type ExclusionPolicy } from "../private/exclusion.js";
import { assertFreshOut, assertOutsideWorkTree } from "../private/out-dir.js";
import { commitFacts, landedPrNumber, mergeCommitFor, type CommitFacts, type MirrorGit, type MissingReason } from "./git-facts.js";
import type { GraphReader, MergedPr } from "./graph.js";

interface HistoryCase extends CommitFacts {
  case_id: string;
  repo: string;
  pr_number: number;
  /** The subject of the commit that landed the PR on main. */
  title: string;
  merged_at: string;
  closed_at: string | null;
}

type Counts<K extends string> = Partial<Record<K, number>>;
type ExcludedCounts = ReturnType<typeof filterPrivate>["excluded"];

interface RepoCounts {
  main_head: string | null;
  graph_merged: number;
  /** PR numbers the main log names at or before `until`, to show how much of main the graph covers. */
  main_log_prs: number;
  with_facts: number;
  missing: Counts<MissingReason>;
  excluded: ExcludedCounts;
}

interface HistorySummary {
  build_id: string;
  until: string;
  cases: number;
  repos: Record<string, RepoCounts>;
  missing: Counts<string>;
  excluded: Counts<string>;
}

export interface HistoryInputs {
  graph: GraphReader;
  mirrorFor: (repo: string) => MirrorGit;
  /** `owner/name`; the policy's repo allowlist still applies to each. */
  repos: readonly string[];
  until: string;
  policy: ExclusionPolicy;
}

interface RepoBuild {
  cases: HistoryCase[];
  counts: RepoCounts;
}

const bump = <K extends string>(counts: Counts<K>, key: K, by = 1): void => void (counts[key] = (counts[key] ?? 0) + by);

function canonicalUntil(until: string): string {
  const time = Date.parse(until);
  if (Number.isNaN(time)) throw new Error(`until is not an ISO time: ${until}`);
  return new Date(time).toISOString();
}

function mainLogPrs(log: readonly MainCommit[], until: string): number {
  const cutoff = Date.parse(until) / 1000;
  return new Set(log.filter((commit) => commit.time <= cutoff).flatMap((commit) => landedPrNumber(commit.subject) ?? [])).size;
}

function caseOf(pr: MergedPr, facts: CommitFacts, commit: MainCommit | undefined): HistoryCase {
  const name = pr.repo.slice(pr.repo.lastIndexOf("/") + 1);
  return { case_id: `${name}#${pr.number}`, repo: pr.repo, pr_number: pr.number, title: commit?.subject ?? "", merged_at: pr.mergedAt, closed_at: pr.closedAt, ...facts };
}

/** The exclusion reads the landing commit's body too, though only its subject is written. */
function subjectOf(entry: HistoryCase, commit: MainCommit | undefined) {
  return { id: entry.case_id, repo: entry.repo, body: { case: entry, message: commit?.body ?? "" }, entry };
}

function buildRepo(repo: string, prs: readonly MergedPr[], git: MirrorGit, inputs: HistoryInputs): RepoBuild {
  const log = git.mainLog();
  const bySha = new Map(log.map((commit) => [commit.sha, commit]));
  const missing: Counts<MissingReason> = {};
  const subjects = prs.flatMap((pr) => {
    const result = commitFacts(git, pr.number);
    if ("missing" in result) {
      bump(missing, result.missing);
      return [];
    }
    const commit = bySha.get(mergeCommitFor(log, pr.number)?.merge ?? "");
    return [subjectOf(caseOf(pr, result.facts, commit), commit)];
  });
  const { kept, excluded } = filterPrivate(subjects, inputs.policy);
  assertNoPrivate(kept, inputs.policy);
  const counts = { main_head: log[0]?.sha ?? null, graph_merged: prs.length, main_log_prs: mainLogPrs(log, inputs.until), with_facts: subjects.length, missing, excluded };
  return { cases: kept.map((subject) => subject.entry), counts };
}

function sumCounts(all: readonly Counts<string>[]): Counts<string> {
  const sum: Counts<string> = {};
  for (const counts of all) for (const [reason, n] of Object.entries(counts)) bump(sum, reason, n);
  return sum;
}

function totals(repos: Record<string, RepoCounts>): Pick<HistorySummary, "missing" | "excluded"> {
  const all = Object.values(repos);
  return { missing: sumCounts(all.map((counts) => counts.missing)), excluded: sumCounts(all.map((counts) => counts.excluded)) };
}

/** Enumerates merged PRs from the graph and computes each one's git facts from its mirror; reads no clock. */
export function buildHistory(inputs: HistoryInputs): { cases: HistoryCase[]; summary: HistorySummary } {
  const until = canonicalUntil(inputs.until);
  const prs = inputs.graph.mergedPrs({ repos: inputs.repos, until });
  const repos: Record<string, RepoCounts> = {};
  const cases: HistoryCase[] = [];
  for (const repo of [...inputs.repos].sort()) {
    const built = buildRepo(repo, prs.filter((pr) => pr.repo === repo), inputs.mirrorFor(repo), { ...inputs, until });
    repos[repo] = built.counts;
    cases.push(...built.cases);
  }
  const buildId = `${until}-${sha256Hex(canonicalJson({ until, prs, repos })).slice(0, 8)}`;
  return { cases, summary: { build_id: buildId, until, cases: cases.length, repos, ...totals(repos) } };
}

/** Writes `cases.jsonl` and `summary.json` into a fresh dir outside every git work tree. */
export async function writeHistory(outDir: string, inputs: HistoryInputs): Promise<HistorySummary> {
  await assertOutsideWorkTree(outDir);
  assertFreshOut(outDir);
  const { cases, summary } = buildHistory(inputs);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "cases.jsonl"), cases.map((entry) => `${canonicalJson(entry)}\n`).join(""));
  writeFileSync(join(outDir, "summary.json"), `${canonicalJson(summary)}\n`);
  return summary;
}
