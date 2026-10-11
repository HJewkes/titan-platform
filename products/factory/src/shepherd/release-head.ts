import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { z } from "zod";
import type { ShepherdStore } from "./store.js";
import { EXIT } from "@titan-design/registry";

export const ReleaseHeadArg = z.string().regex(/^[0-9a-f]{40}$/, "must be the 40-character head sha the hold was reviewed at");

const refused = (message: string, code: number): Error => Object.assign(new Error(message), { code });

/** A release is a statement about one head, the one the seat reviewed: a PR at another head, or a head that cannot be read, refuses it. */
async function assertReleasableAt(port: GitHubPort, repo: RepoSlug, pr: number, head: string): Promise<void> {
  const now = await port.getPr(repo, pr).then((read) => read.headSha, () => undefined);
  if (now === undefined) throw refused(`${repo}#${pr}: the PR's head could not be read, so the release is refused`, EXIT.UNAVAILABLE);
  if (now !== head) throw refused(`${repo}#${pr} is at ${now}, not ${head}: review the new head, then release at it`, EXIT.DATAERR);
}

/** Releases the run's hold, recording the head so a later move off it is known. */
export async function releaseAtHead(store: ShepherdStore, port: GitHubPort, at: { runId: string; repo: RepoSlug; pr: number; head: string }): Promise<void> {
  await assertReleasableAt(port, at.repo, at.pr, at.head);
  store.release(at.runId, { headSha: at.head });
}
