import { formatPrContext, prContext } from "./pr-context.js";
import { formatPrStatus, prStatus } from "./pr-status.js";
import type { GitHubPort, RepoSlug } from "./port.js";
import { isRepo } from "./validate.js";

interface TitanGhIo {
  out(text: string): void;
  err(line: string): void;
}

const USAGE = [
  "usage: titan-gh <verb> <owner/repo#N> [--json]",
  "  pr-status   one line: state, head, mergeable state, required checks, ready or the blockers",
  "  pr-context  title, base, head sha, changed files and body, for a reviewer",
  "  example: titan-gh pr-status octo/widgets#42 --json",
  "exit: 0 printed, 2 usage",
];

type Verb = (port: GitHubPort, repo: RepoSlug, number: number) => Promise<{ value: unknown; text: string }>;

const VERBS = new Map<string, Verb>([
  ["pr-status", async (port, repo, number) => withText(await prStatus(port, repo, number), formatPrStatus)],
  ["pr-context", async (port, repo, number) => withText(await prContext(port, repo, number), formatPrContext)],
]);

/** Read failures propagate, so the bin reports them as an uncaught error with a non-zero exit. */
export async function runTitanGhCli(args: readonly string[], io: TitanGhIo, port: GitHubPort): Promise<number> {
  const json = args.includes("--json");
  const [verb, ref, ...extra] = args.filter((arg) => arg !== "--json");
  const command = verb === undefined ? undefined : VERBS.get(verb);
  const target = ref === undefined ? undefined : parsePrRef(ref);
  if (!command || !target || extra.length > 0) {
    for (const line of USAGE) io.err(line);
    return 2;
  }
  const { value, text } = await command(port, target.repo, target.number);
  io.out(`${json ? JSON.stringify(value) : text}\n`);
  return 0;
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
