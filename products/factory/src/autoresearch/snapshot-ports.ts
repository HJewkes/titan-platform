import type { ArPorts, RunPin, SnapshotLog, Target } from "@titan-design/autoresearch";
import type { GitHubPort } from "@titan-design/github";
import type { SnapshotConfig } from "./config.js";
import { execDatedGit } from "./integrate.js";
import { cutSnapshot, openSnapshotPr, registerSnapshot } from "./snapshot.js";
import { syncRatchet } from "./sync.js";

/** A target's snapshot config plus what the host supplies: the GitHub port and the in-process Shepherd register. */
export interface SnapshotWiring extends SnapshotConfig {
  /** The configured target's name: the tag's `ar/<target>/` segment and the PR title's. */
  target: string;
  port: Pick<GitHubPort, "openPr" | "getPr">;
  register: Parameters<typeof registerSnapshot>[0];
}

type SessionOf = (input: RunPin) => Promise<{ target: Pick<Target, "frozen" | "ratchetPrefix">; defaultBranch: string }>;

const dollars = (usd: number) => `$${usd.toFixed(2)}`;
const keptLine = ({ ideaId, delta, sigma }: SnapshotLog["kept"][number]) =>
  `- ${ideaId}${delta === undefined ? "" : ` Δ ${delta}`}${sigma === undefined ? "" : ` σ ${sigma}`}`;

/** The PR body and the log file: aggregates only, so no case name or per-case number leaves the run. */
export function renderSnapshotLog(runId: string, log: SnapshotLog): string {
  const kept = log.kept.length > 0 ? log.kept.map(keptLine) : ["- none"];
  const spent = `agent ${dollars(log.spentSince.agentUsd)}, model ${dollars(log.spentSince.modelUsd)}`;
  return [`# ar ${runId} ${log.phase}`, "", `Trigger ${log.trigger} at round ${log.round}, ${log.from} to ${log.to}.`, `Spent since the last cut: ${spent}.`, "", "Kept:", ...kept, ""].join("\n");
}

/** The ratchet a run may touch is named by its pinned target and its id, never by the request. */
const ratchetOf = (prefix: string, runId: string) => `refs/heads/${prefix}/${runId}`;

function requireAt(at: string | undefined, code: string): string {
  if (at === undefined) throw new Error(`[${code}] the step recorded no first start to date its commit with`);
  return at;
}

/**
 * The snapshot port cuts, opens the PR and registers it, each idempotent, so a retry after any one of them converges;
 * the sync port reads that PR and merges main back into the ratchet. Both judge refs by the pinned target.
 */
export function snapshotPorts(wiring: SnapshotWiring, sessionOf: SessionOf, treeOf: (runId: string) => string): Required<Pick<ArPorts, "snapshot" | "sync">> {
  const { repo, task, implementer, reviewer, logDir, target: name, port, register } = wiring;
  return {
    snapshot: async (input) => {
      const { target, defaultBranch } = await sessionOf(input);
      const { runId, k, log } = input;
      const body = renderSnapshotLog(runId, log);
      const at = requireAt(input.at, "snapshot-at");
      const refs = { ratchetPrefix: target.ratchetPrefix, ratchetRef: ratchetOf(target.ratchetPrefix, runId), defaultBranch, target: name, runId, k };
      const cut = await cutSnapshot(execDatedGit, { ...refs, tree: treeOf(runId), sha: input.sha, logDir, log: body, frozen: target.frozen, at });
      const { pr } = await openSnapshotPr(port, { repo, branch: cut.branch, base: defaultBranch, target: name, phase: log.phase, k, body });
      const { shepherdRunId } = await registerSnapshot(register, { repo, pr, task, implementer, ...(reviewer !== undefined && { reviewer }), phase: log.phase, k });
      return { k, tag: cut.tag, sha: cut.sha, branch: cut.branch, pr, shepherdRunId, logSha: cut.logSha };
    },
    sync: async (input) => {
      const { target, defaultBranch } = await sessionOf(input);
      const { pr, tree, head, resolved, allowedFrozen } = input;
      const ratchet = { ratchetRef: ratchetOf(target.ratchetPrefix, input.runId), ratchetPrefix: target.ratchetPrefix, defaultBranch };
      const at = requireAt(input.at, "sync-at");
      return syncRatchet(execDatedGit, port, { repo, pr, tree, head, ...ratchet, frozen: target.frozen, logDir, at, ...(resolved !== undefined && { resolved, allowedFrozen: allowedFrozen ?? [] }) });
    },
  };
}
