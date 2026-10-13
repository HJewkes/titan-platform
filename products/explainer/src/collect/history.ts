import { execFileSync } from "node:child_process";
import { z } from "zod";

/** A design decision a commit records; `why` is quoted verbatim from that commit's message, never paraphrased. */
export const DecisionSchema = z.object({
  what: z.string().min(1),
  why: z.string().min(1),
  alternative: z.string().min(1).optional(),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  why_source: z.literal("commit"),
});

export type Decision = z.infer<typeof DecisionSchema>;

export interface HistoryEntry {
  sha: string;
  date: string;
  subject: string;
  removal: boolean;
}

export interface HistoryMine {
  history: HistoryEntry[];
  decisions: Decision[];
}

export interface RejectedDecision {
  decision: unknown;
  reason: string;
}

interface Commit extends HistoryEntry {
  body: string;
}

// Phrases that introduce a reason or a road not taken; a body without one states what changed, not why.
const WHY_WORDS = /\b(because|so that|in order to|instead of|rather than|to avoid|otherwise)\b/i;
const ALTERNATIVE = /\b(?:instead of|rather than)\s+([^.,;:!?]+)/i;
const REMOVAL_VERB = /^(remove|drop|delete|retire)\b/i;
const MAX_BUFFER = 256 * 1024 * 1024;

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] });
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sentences(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .flatMap((paragraph) => normalize(paragraph).split(/(?<=[.!?])\s+/))
    .filter((s) => s.length > 0);
}

/** Commits that delete at least one file; one log call for the whole range. */
function deletingShas(dir: string, ref: string): Set<string> {
  const out = git(dir, ["log", "--no-merges", "--diff-filter=D", "--format=%x1e%H", "--name-only", ref]);
  return new Set(out.split("\x1e").map((record) => record.trim().split("\n")[0] ?? "").filter((sha) => sha !== ""));
}

function readCommits(dir: string, ref: string): Commit[] {
  const deleting = deletingShas(dir, ref);
  const out = git(dir, ["log", "--no-merges", "--format=%H%x1f%aI%x1f%s%x1f%b%x1e", ref]);
  return out
    .split("\x1e")
    .map((record) => record.replace(/^\n/, "").split("\x1f"))
    .flatMap(([sha, date, subject, body]) => {
      if (!sha || !date || subject === undefined) return [];
      const removal = deleting.has(sha) || REMOVAL_VERB.test(subject);
      return [{ sha, date, subject, body: body ?? "", removal }];
    });
}

/** A removal states its reason in its first body sentence; any other commit must use a why-word. */
function decisionFrom(commit: Commit): Decision | undefined {
  const lines = sentences(commit.body);
  const why = lines.find((s) => WHY_WORDS.test(s)) ?? (commit.removal ? lines[0] : undefined);
  if (why === undefined) return undefined;
  const alternative = ALTERNATIVE.exec(why)?.[1]?.trim();
  return { what: commit.subject, why, ...(alternative ? { alternative } : {}), sha: commit.sha, why_source: "commit" };
}

/** K2: mines a local clone's history for decisions with a quotable why. Shells out to git only; no network. */
export function mineHistory(dir: string, ref = "HEAD"): HistoryMine {
  const commits = readCommits(dir, ref);
  return {
    history: commits.map(({ sha, date, subject, removal }) => ({ sha, date, subject, removal })),
    decisions: commits.flatMap((commit) => decisionFrom(commit) ?? []),
  };
}

function commitMessage(dir: string, sha: string): string | undefined {
  try {
    git(dir, ["cat-file", "-e", `${sha}^{commit}`]);
    return git(dir, ["log", "-1", "--format=%B", sha]);
  } catch {
    return undefined;
  }
}

function rejection(dir: string, raw: unknown): string | undefined {
  const parsed = DecisionSchema.safeParse(raw);
  if (!parsed.success) return `invalid decision: ${parsed.error.issues[0]?.message ?? "schema"}`;
  const message = commitMessage(dir, parsed.data.sha);
  if (message === undefined) return `sha ${parsed.data.sha} is not a commit in this clone`;
  if (!normalize(message).includes(normalize(parsed.data.why))) return `why is not quoted verbatim from ${parsed.data.sha}`;
  return undefined;
}

/** Gate for decisions from any source (a model pass, a hand edit): the sha must exist and the why must be a quote. */
export function validateDecisions(dir: string, decisions: unknown[]): { accepted: Decision[]; rejected: RejectedDecision[] } {
  const accepted: Decision[] = [];
  const rejected: RejectedDecision[] = [];
  for (const decision of decisions) {
    const reason = rejection(dir, decision);
    if (reason === undefined) accepted.push(DecisionSchema.parse(decision));
    else rejected.push({ decision, reason });
  }
  return { accepted, rejected };
}
