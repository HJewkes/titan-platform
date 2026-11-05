import type { GitHubPort, PullRequest } from "@titan-design/github";
import type { OwnerOp } from "@titan-design/owner-queue";
import { refused, type Outcome } from "../console-action/outcome.js";
import type { OpRead } from "../console-action/record.js";
import type { FactoryHost } from "../host.js";
import { endRunsGoneElsewhere } from "../shepherd/gone-elsewhere.js";
import type { ShepherdServices } from "../shepherd/services.js";
import type { LedgerLine, OwnerOpsLedger } from "./ledger.js";

type ClosePr = Extract<OwnerOp, { kind: "close-pr" }>;

export interface ClosePrDeps {
  host: FactoryHost;
  port: GitHubPort;
  services: Pick<ShepherdServices, "store">;
  ledger: OwnerOpsLedger;
}

/**
 * Closes the PR only while GitHub shows it open at the head the owner confirmed, so a fix round pushed since is never closed
 * blind. The branch is kept, so reopening is one click. The PR's live Shepherd run is then ended, as a resync would end it.
 */
export async function closePr(actionId: string, { op }: OpRead, deps: ClosePrDeps): Promise<Outcome> {
  if (op.kind !== "close-pr") return refused("record", `close-pr cannot run a ${op.kind} op`);
  const history = await deps.ledger.read(actionId);
  if (history.some(closedByThis)) return { outcome: "already", closedHead: op.headSha };
  const pull = await livePr(deps.port, op);
  if ("outcome" in pull) return pull;
  if (pull.state !== "open") return interrupted(history) && !pull.merged ? finishInterrupted(op, deps) : gone(op, pull);
  if (pull.headSha !== op.headSha) return { outcome: "moved", currentHead: pull.headSha };
  await deps.port.closePr(op.repo, op.pr);
  await endShepherdRun(deps, op);
  return { outcome: "pr-closed", closedHead: op.headSha };
}

const closedByThis = (entry: LedgerLine): boolean => entry.phase === "done" && entry.result !== undefined && "closedHead" in entry.result;

/**
 * `runLogged` appends this call's own `started` before the effect runs, so an earlier call that crashed between its
 * `started` and its `done` shows as a second unmatched `started`.
 */
function interrupted(history: LedgerLine[]): boolean {
  const started = history.filter((entry) => entry.phase === "started").length;
  return started - (history.length - started) > 1;
}

/** An earlier call of this record got as far as its close and no further: the close stands, and the resync it skipped runs now. */
async function finishInterrupted(op: ClosePr, deps: ClosePrDeps): Promise<Outcome> {
  await endShepherdRun(deps, op);
  return { outcome: "already", closedHead: op.headSha };
}

const gone = (op: ClosePr, pull: PullRequest): Outcome => ({ outcome: "gone", reason: `${op.repo}#${op.pr} is ${pull.merged ? "merged" : "closed elsewhere"} on GitHub` });

async function livePr(port: GitHubPort, { repo, pr }: ClosePr): Promise<PullRequest | Outcome> {
  try {
    return await port.getPr(repo, pr);
  } catch (error) {
    return refused("github-unreadable", `${repo}#${pr} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** A cancel that fails here is left to serve's gone sweep, which ends the run on its next pass; the close has already landed. */
async function endShepherdRun({ host, port, services }: ClosePrDeps, { repo, pr }: ClosePr): Promise<void> {
  const runId = services.store.get().byPr(repo, pr)?.runId;
  if (runId === undefined) return;
  await endRunsGoneElsewhere(host, { store: services.store, port }, { scope: "live", only: new Set([runId]), onCancelFailed: () => undefined });
}
