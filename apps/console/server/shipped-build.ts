/**
 * `titan-console shipped build`: the once-a-day writer of the digest `coord.shipped` reads. It groups the day's merged
 * Shepherd runs by initiative, reads each PR's title and body, asks one `claude-print` call per batch for themes and
 * writes `<shippedDir>/<date>.json`. It is the only place the coordinator view calls GitHub or a model.
 */
import { tmpdir } from "node:os";
import type { AgentRunConfig, AgentRunResult } from "@titan-design/agent";
import type { GitHubPort } from "@titan-design/github";
import { z } from "zod";
import { failure } from "./active-work.js";
import type { ShepherdSource } from "./shepherd.js";
import { prSetHash, readShipped, writeDigest, type ShippedDigest } from "./shipped.js";

type Group = ShippedDigest["groups"][number];
type PrRef = Group["unsummarized"][number];

const themeAnswer = z.object({ themes: z.array(z.object({ title: z.string(), summary: z.string(), prs: z.array(z.number().int()) })) });
export type ThemeAnswer = z.infer<typeof themeAnswer>;

/** About 300 merges a day: 40 per call keeps a prompt near 40 KB, and 12 calls caps a day at $6. */
export const BATCH_SIZE = 40;
export const MAX_CALLS = 12;
const BODY_BYTES = 1024;
const CALL_BUDGET_USD = 0.5;
/** `claude-print` exits 2 the same way for a logged-out CLI; the timer reads it as "fix the login", not a bad day. */
export const AUTH_EXIT = 2;

const SYSTEM_PROMPT = "You group merged pull requests into themes for a daily engineering summary. Answer only with the requested JSON.";

export interface ShippedBuildDeps {
  shepherd: Pick<ShepherdSource, "list">;
  github: Pick<GitHubPort, "getSquashSource">;
  run: (config: AgentRunConfig<ThemeAnswer>) => Promise<AgentRunResult<ThemeAnswer>>;
  dir: string;
  dayStart?: string;
  now: number;
}

export interface ShippedBuildOptions {
  date?: string;
  /** Builds themes for this initiative only; the others are written unsummarized. */
  group?: string;
  dryRun: boolean;
  force: boolean;
}

export interface ShippedBuildReport {
  date: string;
  outcome: "built" | "unchanged" | "dry-run";
  merged: number;
  batches: number;
  calls: number;
  promptBytes: number;
  unsummarized: number;
  /** True when GitHub answered 403 and the remaining PRs were left unsummarized. */
  forbidden: boolean;
}

interface Batch {
  initiative: string;
  prs: PrRef[];
}

interface Source extends PrRef {
  title: string;
  body: string;
}

/** Batches of at most 40 per initiative, initiatives in name order; `group` keeps only that initiative's batches. */
export function batchesOf(merged: readonly PrRef[], group?: string): Batch[] {
  const names = [...new Set(merged.map((pr) => pr.initiative))].filter((name) => group === undefined || name === group).sort();
  return names.flatMap((initiative) => {
    const prs = merged.filter((pr) => pr.initiative === initiative).sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
    return Array.from({ length: Math.ceil(prs.length / BATCH_SIZE) }, (_, i) => ({ initiative, prs: prs.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE) }));
  });
}

const isForbidden = (error: unknown): boolean => typeof error === "object" && error !== null && "status" in error && error.status === 403;

function cutBody(body: string): string {
  const bytes = Buffer.from(body, "utf8");
  return bytes.length <= BODY_BYTES ? body : bytes.subarray(0, BODY_BYTES).toString("utf8");
}

/** Serial reads; a 403 sets `forbidden` and every later PR is left unread, so one build cannot burn the hour's quota. */
async function readSources(github: ShippedBuildDeps["github"], prs: readonly PrRef[], state: { forbidden: boolean }): Promise<Source[]> {
  const sources: Source[] = [];
  for (const pr of prs) {
    if (state.forbidden) break;
    try {
      const { title, body } = await github.getSquashSource(pr.repo, pr.number);
      sources.push({ ...pr, title, body: cutBody(body) });
    } catch (error) {
      if (!isForbidden(error)) continue;
      state.forbidden = true;
    }
  }
  return sources;
}

export function promptFor(initiative: string, sources: readonly Source[]): string {
  const items = sources.map((pr) => `## #${pr.number} ${pr.repo} ${pr.task}: ${pr.title}\n${pr.body}`);
  return [
    `These pull requests merged today in the "${initiative}" initiative. Group them into a few themes (at most 6).`,
    "For each theme give a short title, a one or two sentence summary of what shipped, and the PR numbers it covers.",
    "Use only the PR numbers listed below and put each PR in at most one theme.",
    "",
    ...items,
  ].join("\n");
}

/** Keeps only PR numbers the batch holds, each once; an invented number is dropped and an omitted PR is unsummarized. */
export function themesOf(answer: ThemeAnswer, batch: readonly PrRef[]): Pick<Group, "themes" | "unsummarized"> {
  const unclaimed = new Map(batch.map((pr) => [pr.number, pr]));
  const themes = answer.themes.flatMap(({ title, summary, prs }) => {
    const claimed = prs.flatMap((n) => {
      const pr = unclaimed.get(n);
      unclaimed.delete(n);
      return pr === undefined ? [] : [pr];
    });
    return claimed.length === 0 ? [] : [{ title, summary, prs: claimed }];
  });
  return { themes, unsummarized: [...unclaimed.values()] };
}

const sameRef = (a: PrRef, b: PrRef): boolean => a.repo === b.repo && a.number === b.number;

/** A PR the 403 left unread was never shown to the model, so no theme may claim it. */
function withUnread(part: Pick<Group, "themes" | "unsummarized">, batch: readonly PrRef[]): Pick<Group, "themes" | "unsummarized"> {
  const placed = [...part.themes.flatMap((theme) => theme.prs), ...part.unsummarized];
  return { themes: part.themes, unsummarized: [...part.unsummarized, ...batch.filter((pr) => !placed.some((seen) => sameRef(seen, pr)))] };
}

function callConfig(prompt: string): AgentRunConfig<ThemeAnswer> {
  return { harness: "claude-print", model: "sonnet", prompt, systemPrompt: SYSTEM_PROMPT, cwd: tmpdir(), maxTurns: 1, maxBudgetUsd: CALL_BUDGET_USD, outputSchema: themeAnswer };
}

interface BuildState {
  forbidden: boolean;
  calls: number;
  promptBytes: number;
}

/** One batch's group part; a batch past the call cap, unread or dry is all unsummarized. A logged-out CLI aborts the build. */
async function summarize(deps: ShippedBuildDeps, batch: Batch, state: BuildState, dryRun: boolean): Promise<Pick<Group, "themes" | "unsummarized">> {
  const none = { themes: [], unsummarized: batch.prs };
  if (state.calls >= MAX_CALLS) return none;
  const sources = await readSources(deps.github, batch.prs, state);
  if (sources.length === 0) return none;
  const prompt = promptFor(batch.initiative, sources);
  state.promptBytes += Buffer.byteLength(prompt);
  if (dryRun) return none;
  state.calls += 1;
  const result = await deps.run(callConfig(prompt));
  if (result.ok) return withUnread(themesOf(result.output, batch.prs.filter((pr) => sources.some((source) => sameRef(source, pr)))), batch.prs);
  if (result.failure.kind === "auth_misconfigured") throw failure(`shipped build: claude is not logged in (${result.failure.reason}); nothing was written`, AUTH_EXIT);
  return none;
}

/** Initiatives in name order, each once; the `group` filter leaves the rest of the day's PRs listed but unsummarized. */
function mergeGroups(merged: readonly PrRef[], parts: ReadonlyArray<{ initiative: string } & Pick<Group, "themes" | "unsummarized">>): Group[] {
  const names = [...new Set(merged.map((pr) => pr.initiative))].sort();
  return names.map((initiative) => {
    const own = parts.filter((part) => part.initiative === initiative);
    if (own.length === 0) return { initiative, themes: [], unsummarized: merged.filter((pr) => pr.initiative === initiative) };
    return { initiative, themes: own.flatMap((part) => part.themes), unsummarized: own.flatMap((part) => part.unsummarized) };
  });
}

export async function buildShipped(deps: ShippedBuildDeps, options: ShippedBuildOptions): Promise<ShippedBuildReport> {
  const read = await readShipped(deps.shepherd, { dir: deps.dir, ...(deps.dayStart !== undefined && { dayStart: deps.dayStart }) }, deps.now, options.date);
  const batches = batchesOf(read.merged, options.group);
  const state: BuildState = { forbidden: false, calls: 0, promptBytes: 0 };
  const report = (outcome: ShippedBuildReport["outcome"], groups: Group[] = []): ShippedBuildReport => ({
    date: read.date, outcome, merged: read.merged.length, batches: batches.length, calls: state.calls, promptBytes: state.promptBytes,
    unsummarized: groups.reduce((sum, group) => sum + group.unsummarized.length, 0), forbidden: state.forbidden,
  });
  if (read.built && !read.stale && !options.force) return report("unchanged");
  const parts = [];
  for (const batch of batches) parts.push({ initiative: batch.initiative, ...(await summarize(deps, batch, state, options.dryRun)) });
  if (options.dryRun) return report("dry-run");
  const groups = mergeGroups(read.merged, parts);
  await writeDigest(deps.dir, { v: 1, date: read.date, builtAt: new Date(deps.now).toISOString(), prSetHash: prSetHash(read.merged), groups });
  return report("built", groups);
}
