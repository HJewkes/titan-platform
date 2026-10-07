import type { GitHubPort } from "@titan-design/github";
import { deadline, type Deadline } from "../workflows/deadline.js";
import { failureOf } from "./error-class.js";
import type { ShepherdDeps } from "./phases.js";
import { GITHUB_READ_GIVE_UP_MS } from "./timeouts.js";

/** How long a PR that keeps failing to read is waited out before the wake gives up: the give-up main-red also allows a GitHub read it retries. */
export const HEAD_READ_GIVE_UP_MS = GITHUB_READ_GIVE_UP_MS;
const DEFAULT_POLL_MS = 30_000;

export type HeadRead = { moved: boolean } | { error: string };

interface HeadInput {
  repo: string;
  pr: number;
  headSha: string;
}

/** A PR that could not be read is neither moved nor not; the error is kept so the caller can name it if the reads never recover. */
export async function headMoved(port: GitHubPort, input: HeadInput): Promise<HeadRead> {
  try {
    const pr = await port.getPr(input.repo, input.pr);
    return { moved: pr.headSha !== input.headSha };
  } catch (error) {
    return { error: failureOf(error) };
  }
}

/** The clock starts at the first failed read and restarts after a good one, so only an unbroken run of failures gives up. */
export function unreadableHead(deps: ShepherdDeps, input: HeadInput, signal: AbortSignal) {
  let clock: Deadline | undefined;
  return {
    /** Sleeps one poll, or returns the reason once the failures have lasted the whole deadline. */
    async failed(error: string): Promise<string | undefined> {
      clock ??= deadline({ now: deps.now, sleep: deps.sleep, timeoutMs: HEAD_READ_GIVE_UP_MS });
      if (clock.expired()) return `${input.repo}#${input.pr} could not be read for ${HEAD_READ_GIVE_UP_MS / 60_000} minutes, last error: ${error}`;
      await clock.sleep(deps.pollMs ?? DEFAULT_POLL_MS, signal);
      return undefined;
    },
    read(): void {
      clock = undefined;
    },
  };
}
