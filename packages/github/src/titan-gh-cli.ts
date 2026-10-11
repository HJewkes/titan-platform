import { ciWait, type CiWaitOutcome } from "./ci-wait.js";
import type { GitHubPort } from "./port.js";
import { isRepo } from "./validate.js";

interface TitanGhIo {
  port: GitHubPort;
  out(line: string): void;
  err(line: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const USAGE = "usage: titan-gh ci-wait <owner/repo> <sha> [--base <branch>] [--timeout <seconds>] [--interval <seconds>]";

/** Exit codes shared with the scripts this bin replaces: 64 is EX_USAGE, and an unknown sha is a usage error. */
const EXIT: Record<CiWaitOutcome, number> = { green: 0, red: 1, timeout: 2, "unknown-sha": 64 };
const USAGE_EXIT = 64;

interface CiWaitArgs {
  repo: string;
  sha: string;
  base?: string;
  timeoutSeconds: number;
  intervalSeconds: number;
}

export async function runTitanGh(args: readonly string[], io: TitanGhIo): Promise<number> {
  const [verb, ...rest] = args;
  const parsed = verb === "ci-wait" ? parseCiWait(rest) : null;
  if (!parsed) {
    io.err(USAGE);
    return USAGE_EXIT;
  }
  const result = await ciWait(io.port, { ...parsed, now: io.now, sleep: io.sleep, onReadError: (error) => io.err(`ci-wait: read failed, retrying: ${error instanceof Error ? error.message : String(error)}`) });
  (result.outcome === "unknown-sha" ? io.err : io.out)(result.line);
  return EXIT[result.outcome];
}

const SECONDS = /^\d+$/;
const BASE = /^[A-Za-z0-9._/-]+$/;
const SHA = /^[0-9a-fA-F]{7,40}$/;

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
