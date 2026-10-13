import { dataFence } from "@titan-design/agent-dispatch";
import { GITHUB_ACTIONS_APP_ID, type GitHubPort } from "@titan-design/github";
import { z } from "zod";
import type { CiInput, CiSnapshot, FailingCheck } from "../workflows/land-ci.js";

/** How long a head may wait with a required check GitHub never started before ci-wait reads why; Actions starts a run within seconds of a push. */
export const NO_RUN_GRACE_MS = 5 * 60_000;

/** The tokens GitHub Actions honours in a head commit message to start no workflow run for it. */
const SKIP_TOKEN = /\[(skip ci|ci skip|no ci|skip actions|actions skip)\]|^skip-checks: ?true$/im;
const NO_RUN_CHECK = "no CI run: head commit message carries ";

/** What one ci-wait has seen of the head it waits on: since when it waits, and its commit message once read. */
export interface NoRunWatch {
  pendingSince?: { headSha: string; at: number };
  message?: { headSha: string; text: string };
}

export function skipTokenIn(message: string): string | undefined {
  const match = SKIP_TOKEN.exec(message);
  if (!match) return undefined;
  return match[1] === undefined ? "skip-checks: true" : `[${match[1].toLowerCase()}]`;
}

/**
 * A head GitHub Actions started no run for never turns green, so past the grace ci-wait reads why. A conflict reads as
 * not-mergeable, which Shepherd's conflict fix round takes; a skip token reads as red, so the fixer is woken to push a
 * fresh commit. An unsettled mergeable state, a failed read or any other cause keeps the wait as it was.
 */
export async function noRunVerdict(port: GitHubPort, input: CiInput, pending: CiSnapshot, now: number, watch: NoRunWatch): Promise<CiSnapshot | undefined> {
  if (!pastGrace(pending, now, watch)) return undefined;
  try {
    if (await actionsStartedAt(port, input, pending.headSha)) return undefined;
    if (pending.mergeableState === "dirty") return { ...pending, verdict: "not-mergeable" };
    const token = skipTokenIn(await headMessage(port, input, pending.headSha, watch));
    return token === undefined ? undefined : { ...pending, verdict: "red", failing: [noRunCheck(token)] };
  } catch {
    return undefined;
  }
}

/** A backlog read already names a run for every check it waits on, so only a wait on a check never started is probed. */
function pastGrace(pending: CiSnapshot, now: number, watch: NoRunWatch): boolean {
  if (watch.pendingSince?.headSha !== pending.headSha) watch.pendingSince = { headSha: pending.headSha, at: now };
  return pending.verdict === "pending" && pending.backlog !== true && now - watch.pendingSince.at >= NO_RUN_GRACE_MS;
}

async function actionsStartedAt(port: GitHubPort, input: CiInput, headSha: string): Promise<boolean> {
  return (await port.checkRuns(input.repo, headSha)).some((run) => run.appId === GITHUB_ACTIONS_APP_ID);
}

async function headMessage(port: GitHubPort, input: CiInput, headSha: string, watch: NoRunWatch): Promise<string> {
  if (watch.message?.headSha !== headSha) watch.message = { headSha, text: (await port.getCommit(input.repo, headSha)).message ?? "" };
  return watch.message.text;
}

function noRunCheck(token: string): FailingCheck {
  return { name: `${NO_RUN_CHECK}${token}`, conclusion: null, url: "", workflowRunId: null };
}

const RedPayload = z.looseObject({ failing: z.array(z.looseObject({ name: z.string() })) });

/** The ci-red wake for a head no CI ran on asks for a fresh commit; absent for any other red. */
export function noRunWake(headSha: string, payload: unknown): { reason: string; payload: string } | undefined {
  const red = RedPayload.safeParse(payload);
  const check = red.success ? red.data.failing.find((entry) => entry.name.startsWith(NO_RUN_CHECK)) : undefined;
  if (check === undefined) return undefined;
  const reason = `GitHub started no CI run at head ${headSha}, because its commit message carries a skip token, so its required checks will never report. Push a fresh commit whose message carries no skip token; an empty commit is enough.`;
  return { reason, payload: dataFence("skip token", check.name.slice(NO_RUN_CHECK.length)) };
}
