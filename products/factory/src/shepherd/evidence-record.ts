import type { AgentIdentity, CarryFact, MergeFacts } from "@titan-design/authority";
import type { CheckRun, PullRequest, RepoSlug } from "@titan-design/github";
import type { CiPolicy, SourceTextLocator } from "@titan-design/session-read";
import type { GateDecision } from "../gate-policy.js";
import type { AttestJudgment } from "./attest-evidence.js";
import type { CiPolicyFileChange } from "./ci-policy-changes.js";
import type { RiskTier } from "./risk-tier.js";
import type { VisualDelta } from "./visual-delta-read.js";
import type { VisualTierRecord } from "./visual-tier-guard.js";
import type { OldPathRecord } from "../old-path/freeze-gate.js";

interface EvidenceCheckRun {
  name: string;
  id: number;
  appId: number | null;
  conclusion: string | null;
}

/** What `allowEvidence` stores in `merge-policy`, whole. The PR comment carries the same record with `verdictLocator` reduced to a `LocatorReference`. */
export interface EvidenceRecord {
  runId: string;
  repo: RepoSlug;
  pr: number;
  head: string;
  baseRef: string;
  testMergeSha: string | null;
  checkRuns: EvidenceCheckRun[];
  verdictLocator: SourceTextLocator;
  reviewer: AgentIdentity;
  decision: GateDecision;
  /** The `mergeable_state` the decision judged, after any re-reads. */
  mergeableState: string;
  /** Set when the verdict was reviewed at another head and carried here: both heads and both trees. */
  carry?: CarryFact;
  ciPolicy?: CiPolicy;
  /** On a weakened line, every changed line of the changed `.github/` files, shown or counted, for the D21 card. */
  ciPolicyChanges?: CiPolicyFileChange[];
  /** On a weakened line, each changed path's git blob sha at head (null: absent there), for a CI-policy plan approval's pins. */
  headBlobs?: Record<string, string | null>;
  proofUnverified?: string;
  proofBase?: string;
  /** The head's risk tier and why (TP-3734 r1); shadow only, so nothing decides on it yet. */
  riskTier?: RiskTier;
  /** The measured visual delta under `shepherd.visualThreshold` (TP-4320); absent when that is off for the repo. */
  visualDelta?: VisualDelta;
  /** The visual tier under `shepherd.visualTier` (TP-4761); absent when that is off for the repo or no visual path changed. */
  visualTier?: VisualTierRecord;
  /** Under `shepherd.visualGate: async` (TP-5408), the changed paths the run's visual globs match; nothing gates on them. */
  visualChanged?: string[];
  /** Under `shepherd.visualGate: async`, the mode the decision was made under. */
  visualGate?: "async";
  /** Each claimed attestation row met at this head, with the roster rows that met it (TP-3110). */
  attested?: { step: string; closure: string; meeters: { name: string; agentId: string; shape: "correctness" | "adversary" }[] }[];
  /** Each claimed row left unmet, and why. */
  attestUnmet?: { step: string; why: string }[];
  /** Why the claims or the meeters' facts could not be read. */
  attestUnread?: string;
  /** Why the attest read waited for a deploy instead of judging (TP-4752). */
  attestWaiting?: string;
  /** The old-path freeze verdict, its task and the registered kind (TP-3182); recorded before M1b exit too, so its counts inform the exit. */
  oldPath?: OldPathRecord;
}

/** The parts of the evidence step's input a record names. */
type RecordInput = Pick<EvidenceRecord, "runId" | "repo" | "pr" | "head" | "proofUnverified" | "proofBase"> & { verdict: { locator: SourceTextLocator }; resolver: AgentIdentity };

interface RecordObserved {
  pr: PullRequest;
  merge: MergeFacts;
  runs: CheckRun[];
  ciPolicyChanges?: CiPolicyFileChange[];
  headBlobs?: Record<string, string | null>;
}

type RecordExtras = Pick<EvidenceRecord, "ciPolicy" | "visualDelta" | "visualTier" | "visualChanged" | "visualGate" | "oldPath"> & { riskTier: RiskTier; attest?: AttestJudgment };

/** A head that claims nothing records nothing; a meeter other than the accepted reviewer is the adversary member. */
function attestFields(attest: AttestJudgment | undefined, resolver: AgentIdentity): Pick<EvidenceRecord, "attested" | "attestUnmet" | "attestUnread" | "attestWaiting"> {
  if (attest === undefined) return {};
  if ("unread" in attest) return { attestUnread: attest.unread };
  if ("deploySkew" in attest) return { attestWaiting: attest.deploySkew };
  const attested = attest.met.map(({ step, closure, meeters }) => ({
    step,
    closure,
    meeters: meeters.map(({ name, agentId }) => ({ name, agentId, shape: agentId === resolver.agentId ? ("correctness" as const) : ("adversary" as const) })),
  }));
  return { attested, attestUnmet: attest.unmet.map(({ step, why }) => ({ step, why })) };
}

/** The head's fix-proof standing and judged base, absent keys left out so a record spreads them as they are. */
const proofFields = (input: RecordInput): Pick<EvidenceRecord, "proofUnverified" | "proofBase"> => ({
  ...(input.proofUnverified !== undefined && { proofUnverified: input.proofUnverified }),
  ...(input.proofBase !== undefined && { proofBase: input.proofBase }),
});

export function evidenceRecord(
  input: RecordInput,
  { pr, merge, runs, ciPolicyChanges, headBlobs }: RecordObserved,
  decision: GateDecision,
  { ciPolicy, riskTier, visualDelta, visualTier, visualChanged, visualGate, attest, oldPath }: RecordExtras,
): EvidenceRecord {
  return {
    runId: input.runId,
    repo: input.repo,
    pr: input.pr,
    head: input.head,
    baseRef: pr.baseRef,
    testMergeSha: pr.mergeSha,
    checkRuns: runs.map((run) => ({ name: run.name, id: run.id, appId: run.appId, conclusion: run.conclusion })),
    verdictLocator: input.verdict.locator,
    reviewer: input.resolver,
    decision,
    mergeableState: pr.mergeableState,
    ...(merge.carry && { carry: merge.carry }),
    ...(ciPolicy && { ciPolicy }),
    ...(ciPolicyChanges && { ciPolicyChanges }),
    ...(headBlobs && { headBlobs }),
    ...proofFields(input),
    riskTier,
    ...(visualDelta && { visualDelta }),
    ...(visualTier && { visualTier }),
    ...(visualChanged && { visualChanged }),
    ...(visualGate && { visualGate }),
    ...attestFields(attest, input.resolver),
    ...(oldPath && { oldPath }),
  };
}
