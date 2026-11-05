/**
 * CC-1678: one PR's state for the broker's merged-PR retire. The read is async, since a blocking
 * runner would stall every session, and the host decides which budget it spends: `refusal` lets a
 * cooling lane turn the read away before it reaches GitHub, and `after` is where each call is logged
 * and a rate limit starts a cooldown.
 */

/** A PR's head at the time it was read; what a park backs an agent's branch with. */
export interface PrHead {
  number: number;
  headSha: string;
}

export interface PrState {
  state: "OPEN" | "MERGED" | "CLOSED";
  head: PrHead;
}

/** Rejects when the state cannot be told, which the sweep treats as a kept agent. */
export type PrStateReader = (pr: string) => Promise<PrState>;

export interface GhOutcome {
  exitCode: number;
  stdout: string;
}

export interface PrStateDeps {
  /** Why a `gh` read must not start now, or undefined. */
  refusal(args: readonly string[]): Promise<string | undefined>;
  gh(args: readonly string[]): Promise<GhOutcome>;
  /** Runs after every call that started, whatever its exit code. */
  after(args: readonly string[], outcome: GhOutcome): Promise<void>;
}

export interface PrTarget {
  repo: string;
  pr: number;
}

/** `https://github.com/<owner>/<repo>/pull/<n>` or `<owner>/<repo>#<n>`; anything else is not a PR reference. */
export function prTarget(pr: string | undefined): PrTarget | undefined {
  if (pr === undefined) return undefined;
  const match =
    /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(
      pr
    ) ?? /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(pr);
  const [, repo, num] = match ?? [];
  return repo === undefined || num === undefined ? undefined : { repo, pr: Number(num) };
}

const LEAD = String.raw`^[\s*_\x60>#-]*`;
const KEY_END = String.raw`[*_\x60]*\s*:[\s*_\x60]*`;
const PR_LINE = new RegExp(`${LEAD}pr${KEY_END}(\\S+)`, "im");
const PR_REF = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/;

/** `PR:` as `owner/repo#n`; a GitHub pull URL is rewritten to that form, and anything else is not a PR. */
export function reportPr(report: string): string | null {
  const value = PR_LINE.exec(report)?.[1]?.replace(/[*_`.,;)]+$/, "");
  if (value === undefined) return null;
  const ref = PR_REF.exec(value) ?? PR_URL.exec(value);
  return ref === null ? null : `${ref[1]}#${ref[2]}`;
}

export function parsePrState(stdout: string, number: number): PrState {
  const parsed: unknown = JSON.parse(stdout);
  const { state, headRefOid } = isRecord(parsed) ? parsed : {};
  if (
    (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED") ||
    typeof headRefOid !== "string"
  )
    throw new Error("gh pr view answered without a known state and headRefOid");
  return { state, head: { number, headSha: headRefOid } };
}

export const prStateReader =
  (deps: PrStateDeps): PrStateReader =>
  async (pr) => {
    const target = prTarget(pr);
    if (target === undefined) throw new Error(`${pr} is not a PR reference`);
    const args = [
      "pr",
      "view",
      String(target.pr),
      "--repo",
      target.repo,
      "--json",
      "state,headRefOid",
    ];
    const refused = await deps.refusal(args);
    if (refused !== undefined) throw new Error(refused);
    const outcome = await deps.gh(args);
    await deps.after(args, outcome);
    if (outcome.exitCode !== 0)
      throw new Error(`gh pr view ${pr} exited ${outcome.exitCode}`);
    return parsePrState(outcome.stdout, target.pr);
  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
