import { execFileSync } from "node:child_process";
import { z } from "zod";

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A design decision a commit records; `why` is quoted verbatim from that commit's message, never paraphrased. */
const DecisionSchema = z.object({
  what: z.string().min(1),
  why: z.string().min(1),
  alternative: z.string().min(1).optional(),
  sha: z.string().regex(SHA),
  why_source: z.literal("commit"),
});

export type Decision = z.infer<typeof DecisionSchema>;

interface HistoryEntry {
  sha: string;
  date: string;
  subject: string;
  removal: boolean;
}

interface HistoryMine {
  history: HistoryEntry[];
  decisions: Decision[];
  /** False in a shallow clone: history[] then stops at the graft and must not be presented as the whole record. */
  complete: boolean;
}

interface MineOptions {
  timeoutMs?: number;
}

type Git = (args: string[]) => string;

interface RejectedDecision {
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
const GIT_TIMEOUT_MS = 60_000;
// A shorter quote ("the", "cache") is found in almost any message, so it proves nothing about the reason.
const MIN_WHY_WORDS = 4;
// The clone is untrusted: its own config could otherwise make `git log` verify signatures with a program it names,
// or, in a partial clone, lazily fetch missing objects through a remote and transport command it names.
const PINNED_CONFIG = [
  "log.showSignature=false",
  "gpg.program=false",
  "gpg.ssh.program=false",
  "gpg.x509.program=false",
  "protocol.allow=never",
];

// An inherited GIT_DIR, GIT_CONFIG_PARAMETERS or the like would override `-C dir` and the pins.
function gitEnv(): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"));
  return { ...Object.fromEntries(inherited), GIT_NO_LAZY_FETCH: "1" };
}

function gitIn(dir: string, timeoutMs = GIT_TIMEOUT_MS): Git {
  const pins = PINNED_CONFIG.flatMap((pin) => ["-c", pin]);
  const env = gitEnv();
  return (args) =>
    execFileSync("git", [...pins, "-C", dir, ...args], {
      encoding: "utf8",
      env,
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    });
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function wordCount(text: string): number {
  return normalize(text).split(" ").filter((w) => w !== "").length;
}

function sentences(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .flatMap((paragraph) => normalize(paragraph).split(/(?<=[.!?])\s+/))
    .filter((s) => wordCount(s) >= MIN_WHY_WORDS);
}

function checkedSha(sha: string, seen: Set<string>): string {
  if (!SHA.test(sha)) throw new Error(`git log record has a malformed sha: ${JSON.stringify(sha.slice(0, 80))}`);
  if (seen.has(sha)) throw new Error(`git log record repeats sha ${sha}`);
  seen.add(sha);
  return sha;
}

/** Commits that delete at least one file; shas only, so no file name can pose as one. */
function deletingShas(git: Git, ref: string): Set<string> {
  const out = git(["log", "--no-merges", "--diff-filter=D", "--format=%H", "--end-of-options", ref]);
  const seen = new Set<string>();
  for (const sha of out.split("\n").filter((line) => line !== "")) checkedSha(sha, seen);
  return seen;
}

// NUL is the one byte a commit message cannot carry, so a body cannot forge a record boundary.
function readCommits(git: Git, ref: string): Commit[] {
  const deleting = deletingShas(git, ref);
  const fields = git(["log", "-z", "--no-merges", "--format=%H%x00%aI%x00%s%x00%b", "--end-of-options", ref]).split("\0");
  if (fields.pop() !== "" || fields.length % 4 !== 0) throw new Error("git log output is not whole NUL-delimited records");
  const seen = new Set<string>();
  const commits: Commit[] = [];
  for (let i = 0; i < fields.length; i += 4) {
    const [rawSha = "", date = "", subject = "", body = ""] = fields.slice(i, i + 4);
    const sha = checkedSha(rawSha, seen);
    commits.push({ sha, date, subject, body, removal: deleting.has(sha) || REMOVAL_VERB.test(subject) });
  }
  return commits;
}

/** A removal states its reason in its first body sentence; any other commit must use a why-word. */
function decisionFrom(commit: Commit): Decision | undefined {
  const lines = sentences(commit.body);
  const why = lines.find((s) => WHY_WORDS.test(s)) ?? (commit.removal ? lines[0] : undefined);
  if (why === undefined) return undefined;
  const alternative = ALTERNATIVE.exec(why)?.[1]?.trim();
  return { what: commit.subject, why, ...(alternative ? { alternative } : {}), sha: commit.sha, why_source: "commit" };
}

/**
 * K2: mines a local clone's history for decisions with a quotable why. Shells out to git only and never fetches:
 * lazy fetches and every transport are disabled, so a partial clone missing the objects it needs throws instead.
 */
export function mineHistory(dir: string, ref = "HEAD", { timeoutMs }: MineOptions = {}): HistoryMine {
  const git = gitIn(dir, timeoutMs);
  const commits = readCommits(git, ref);
  return {
    history: commits.map(({ sha, date, subject, removal }) => ({ sha, date, subject, removal })),
    decisions: commits.flatMap((commit) => decisionFrom(commit) ?? []),
    complete: git(["rev-parse", "--is-shallow-repository"]).trim() === "false",
  };
}

/** Subject and body; the why is matched against the body only, since a quote of the subject restates what changed. */
function commitText(git: Git, sha: string): { subject: string; body: string } | undefined {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
    const [subject = "", ...body] = git(["log", "-1", "--format=%s%x00%b", "--end-of-options", sha]).split("\0");
    return { subject, body: body.join("\0") };
  } catch {
    return undefined;
  }
}

function rejection(git: Git, raw: unknown): string | undefined {
  const parsed = DecisionSchema.safeParse(raw);
  if (!parsed.success) return `invalid decision: ${parsed.error.issues[0]?.message ?? "schema"}`;
  const { what, why, alternative, sha } = parsed.data;
  if (wordCount(why) < MIN_WHY_WORDS) return `why is shorter than ${MIN_WHY_WORDS} words`;
  const text = commitText(git, sha);
  if (text === undefined) return `sha ${sha} is not a commit in this clone`;
  if (what !== text.subject) return `what is not the subject of ${sha}`;
  if (!normalize(text.body).includes(normalize(why))) return `why is not quoted verbatim from the body of ${sha}`;
  if (alternative !== undefined && !why.includes(alternative)) return "alternative is not quoted from the why";
  return undefined;
}

/** Gate for decisions from any source (a model pass, a hand edit): the sha must exist, what must be its subject, the why a quote. */
export function validateDecisions(
  dir: string,
  decisions: unknown[],
  { timeoutMs }: MineOptions = {},
): { accepted: Decision[]; rejected: RejectedDecision[] } {
  const git = gitIn(dir, timeoutMs);
  const accepted: Decision[] = [];
  const rejected: RejectedDecision[] = [];
  for (const decision of decisions) {
    const reason = rejection(git, decision);
    if (reason === undefined) accepted.push(DecisionSchema.parse(decision));
    else rejected.push({ decision, reason });
  }
  return { accepted, rejected };
}
