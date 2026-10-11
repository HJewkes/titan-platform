import type { GitHubPort } from "@titan-design/github";
import type { WorkflowRun } from "@titan-design/workflow";
import { checksAt, verdictAt, type EvidenceSources } from "./coordinator-evidence-read.js";
import { landGate } from "./coordinator-evidence.js";
import { batchRefusal } from "./gate-batch-plan.js";
import type { FactoryHost } from "./host.js";

interface ReviewVerdict {
  verdict: string;
  reviewer: string;
}

interface ReviewChecks {
  state: "green" | "failing" | "pending" | "unreadable";
  failing: string[];
}

/** One pending gate as an owner reviews it. A gate that is no land merge gate carries no PR, head or rule. */
export interface ReviewGate {
  gateId: string;
  runId: string;
  stepId: string;
  repo: string | null;
  pr: number | null;
  headSha: string | null;
  rule: string | null;
  /** True when the gate may ride in a batch; otherwise why it stays one per proof. */
  batchable: true | { refusal: string };
  /** The reviewer's verdict recorded at exactly `headSha`; null when there is none or it was not read. */
  verdict: ReviewVerdict | null;
  checks: ReviewChecks;
  createdAt: string;
}

const UNREADABLE: ReviewChecks = { state: "unreadable", failing: [] };

/**
 * Reads every pending gate for review, changing nothing: no store write, no resolve. Without Shepherd's sources the
 * verdict and checks stay unread; a GitHub error on one gate leaves only that gate's checks unreadable.
 */
export async function reviewGates(host: FactoryHost, sources?: EvidenceSources): Promise<ReviewGate[]> {
  const port = sources && rulesOncePerRepo(sources.port);
  return Promise.all(host.pendingGates().map(async ({ runId, stepId, gate }): Promise<ReviewGate> => {
    const land = landGate(gate);
    const refusal = batchRefusal(gate);
    const { repo, pr, head: headSha, rule } = land ?? { repo: null, pr: null, head: null, rule: null };
    const run = host.runtime.status(runId);
    const read = land && port && run ? await readEvidence(port, run, land) : { verdict: null, checks: UNREADABLE };
    return { gateId: gate.id, runId, stepId, repo, pr, headSha, rule, batchable: refusal === undefined ? true : { refusal }, ...read, createdAt: gate.createdAt };
  }));
}

async function readEvidence(port: GitHubPort, run: WorkflowRun, land: { repo: string; pr: number; head: string }): Promise<{ verdict: ReviewVerdict | null; checks: ReviewChecks }> {
  const found = verdictAt(run, land.head);
  const verdict = found ? { verdict: found.verdict, reviewer: found.reviewer } : null;
  try {
    const pull = await port.getPr(land.repo, land.pr);
    return { verdict, checks: await checksAt(port, land.repo, pull.baseRef, land.head) };
  } catch {
    return { verdict, checks: UNREADABLE };
  }
}

/** Twenty gates on one repo ask the rules once; the answer, or its failure, is shared for this read only. */
function rulesOncePerRepo(port: GitHubPort): GitHubPort {
  const seen = new Map<string, ReturnType<GitHubPort["requiredChecks"]>>();
  return {
    ...port,
    requiredChecks: (repo, branch) => {
      const key = `${repo}@${branch}`;
      const known = seen.get(key) ?? port.requiredChecks(repo, branch);
      seen.set(key, known);
      return known;
    },
  };
}
