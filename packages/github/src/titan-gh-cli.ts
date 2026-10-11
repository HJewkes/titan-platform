import type { CleanMergeTree } from "./approved-head-walk.js";
import { ciWait, type CiWaitOutcome } from "./ci-wait.js";
import { formatPrContext, prContext } from "./pr-context.js";
import { formatPrStatus, prStatus } from "./pr-status.js";
import { formatPremerge, premerge } from "./premerge.js";
import type { GitHubPort, RepoSlug } from "./port.js";
import { isRepo } from "./validate.js";

interface TitanGhIo {
  port: GitHubPort;
  out(line: string): void;
  err(line: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** The clean-merge proof for `premerge --clone <dir>`; absent, a walked approval fails closed. */
  mergeTree?: (clone: string) => CleanMergeTree;
}

const USAGE = [
  "usage: titan-gh ci-wait <owner/repo> <sha> [--base <branch>] [--timeout <seconds>] [--interval <seconds>]",
  "       titan-gh pr-status <owner/repo#N> [--json]   state, head, mergeable state, required checks, ready or the blockers",
  "       titan-gh pr-context <owner/repo#N> [--json]  title, base, head sha, changed files and body, for a reviewer",
  "       titan-gh premerge <owner/repo#N> <sha> --approved-head <sha> [--clone <dir>] [--json]  OK or FAIL <reasons>; exits 0, 1, or 2 on usage",
  "  example: titan-gh pr-status octo/widgets#42 --json",
];

/** Exit codes shared with the scripts this bin replaces: 64 is EX_USAGE, and an unknown sha is a usage error. */
const EXIT: Record<CiWaitOutcome, number> = { green: 0, red: 1, timeout: 2, "unknown-sha": 64 };
const USAGE_EXIT = 64;
/** premerge keeps the exit codes of agent-chat's `scripts/seat/premerge`, which its shim forwards. */
const PREMERGE_EXIT = { ok: 0, fail: 1, usage: 2 } as const;

interface CiWaitArgs {
  repo: string;
  sha: string;
  base?: string;
  timeoutSeconds: number;
  intervalSeconds: number;
}

type PrVerb = (port: GitHubPort, repo: RepoSlug, number: number) => Promise<{ value: unknown; text: string }>;

const PR_VERBS = new Map<string, PrVerb>([
  ["pr-status", async (port, repo, number) => withText(await prStatus(port, repo, number), formatPrStatus)],
  ["pr-context", async (port, repo, number) => withText(await prContext(port, repo, number), formatPrContext)],
]);

/** Read failures in the pr verbs propagate, so the bin reports them as an uncaught error with a non-zero exit. */
export async function runTitanGh(args: readonly string[], io: TitanGhIo): Promise<number> {
  const [verb, ...rest] = args;
  const prVerb = verb === undefined ? undefined : PR_VERBS.get(verb);
  if (prVerb) return runPrVerb(prVerb, rest, io);
  if (verb === "premerge") return runPremerge(rest, io);
  const parsed = verb === "ci-wait" ? parseCiWait(rest) : null;
  if (!parsed) return usage(io);
  const result = await ciWait(io.port, { ...parsed, now: io.now, sleep: io.sleep, onReadError: (error) => io.err(`ci-wait: read failed, retrying: ${error instanceof Error ? error.message : String(error)}`) });
  (result.outcome === "unknown-sha" ? io.err : io.out)(result.line);
  return EXIT[result.outcome];
}

async function runPrVerb(verb: PrVerb, args: readonly string[], io: TitanGhIo): Promise<number> {
  const json = args.includes("--json");
  const [ref, ...extra] = args.filter((arg) => arg !== "--json");
  const target = ref === undefined ? undefined : parsePrRef(ref);
  if (!target || extra.length > 0) return usage(io);
  const { value, text } = await verb(io.port, target.repo, target.number);
  io.out(json ? JSON.stringify(value) : text);
  return 0;
}

async function runPremerge(args: readonly string[], io: TitanGhIo): Promise<number> {
  const parsed = parsePremerge(args);
  if (!parsed) {
    usage(io);
    return PREMERGE_EXIT.usage;
  }
  const { json, clone, ...input } = parsed;
  const result = await premerge(io.port, { ...input, ...(clone !== undefined && io.mergeTree ? { cleanMergeTree: io.mergeTree(clone) } : {}) });
  io.out(json ? JSON.stringify(result) : formatPremerge(result));
  return result.ok ? PREMERGE_EXIT.ok : PREMERGE_EXIT.fail;
}

function usage(io: TitanGhIo): number {
  for (const line of USAGE) io.err(line);
  return USAGE_EXIT;
}

function withText<T>(value: T, format: (value: T) => string): { value: T; text: string } {
  return { value, text: format(value) };
}

/** `owner/repo#N`; anything else is undefined, so the caller prints usage before any GitHub read. */
function parsePrRef(ref: string): { repo: RepoSlug; number: number } | undefined {
  const match = /^([^#]+)#([1-9][0-9]*)$/.exec(ref);
  if (!match || !isRepo(match[1]!)) return undefined;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) ? { repo: match[1]!, number } : undefined;
}

const SECONDS = /^\d+$/;
const BASE = /^[A-Za-z0-9._/-]+$/;
const SHA = /^[0-9a-fA-F]{7,40}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

/** Null on any malformed argument, so nothing reaches GitHub that the old script would have refused. */
function parseCiWait(args: readonly string[]): CiWaitArgs | null {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) positional.push(arg);
    else if (["--base", "--timeout", "--interval"].includes(arg) && i + 1 < args.length) flags[arg] = args[++i]!;
    else return null;
  }
  const [repo, sha] = positional;
  if (positional.length !== 2 || !isRepo(repo!) || !SHA.test(sha!)) return null;
  const { "--base": base, "--timeout": timeout = "540", "--interval": interval = "30" } = flags;
  if (!SECONDS.test(timeout) || !SECONDS.test(interval) || (base !== undefined && !BASE.test(base))) return null;
  return { repo: repo!, sha: sha!.toLowerCase(), ...(base === undefined ? {} : { base }), timeoutSeconds: Number(timeout), intervalSeconds: Number(interval) };
}

interface PremergeArgs {
  repo: RepoSlug;
  number: number;
  headSha: string;
  approvedHead: string;
  clone?: string;
  json: boolean;
}

/** Both shas must be full and lower-case, as the script this replaces demanded. */
function parsePremerge(args: readonly string[]): PremergeArgs | null {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") json = true;
    else if (!arg.startsWith("-")) positional.push(arg);
    else if (["--approved-head", "--clone"].includes(arg) && i + 1 < args.length) flags[arg] = args[++i]!;
    else return null;
  }
  const [ref, headSha] = positional;
  const target = ref === undefined ? undefined : parsePrRef(ref);
  const { "--approved-head": approvedHead, "--clone": clone } = flags;
  if (!target || positional.length !== 2 || !FULL_SHA.test(headSha!) || approvedHead === undefined || !FULL_SHA.test(approvedHead)) return null;
  return { ...target, headSha: headSha!, approvedHead, ...(clone === undefined ? {} : { clone }), json };
}
