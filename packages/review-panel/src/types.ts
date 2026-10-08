import type { ReviewTarget } from "./ports.js";

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

/** What the caller knows about a pull request; classification reads nothing else, and no model reads the diff. */
export interface PrFacts extends ReviewTarget {
  /** The base branch's head commit. */
  base: string;
  /** The registered kind; absent means unread, which takes the strict class. */
  kind?: string;
  changedFiles: readonly ChangedFile[];
  /** The caller already knows the PR touches authority, whatever its paths say. */
  authorityTouch?: boolean;
  /** The caller already knows the PR touches policy, whatever its paths say. */
  policyTouch?: boolean;
}

/** `g10` is an authority, policy, security or migration touch, an unread kind, or a large PR; everything else is `standard`. */
export type ReviewClass = "g10" | "standard";

/** `untested` is a source change with no test change; `perf` is a hot-path touch. */
export type PrTouch = "authority" | "policy" | "migration" | "visual" | "security" | "perf" | "untested" | "large";

export interface PrClass {
  class: ReviewClass;
  /** The touches choose the panel's shapes; the class chooses their tier. */
  touches: readonly PrTouch[];
}

/** The question a panel member owns; each shape is a brief overlay on the common base brief. */
export type ReviewShape = "correctness" | "adversary" | "tests" | "visual" | "perf";

export interface PanelMember {
  shape: ReviewShape;
  /** The agent-chat profile, which carries the member's model and effort. */
  profile: string;
  /** The stable id of the member's brief variant. */
  briefId: string;
  /** Only a blocking member's FIX_FIRST blocks, and only its MERGE counts toward the panel's MERGE. */
  blocking: boolean;
  /** Planned at a sonnet profile because opus was refused. */
  degraded: boolean;
}

export interface PanelPlan {
  class: PrClass;
  /** At most one member per shape. */
  members: readonly PanelMember[];
  /** Agent-chat points for one round; an estimate, never a cap. */
  spendEstimate: number;
  /** Some member is degraded. */
  degraded: boolean;
}

/** `no-verdict` and `timeout` mean a blocking member gave none, which is never read as consent. */
export type PanelOutcome = "MERGE" | "FIX_FIRST" | "no-verdict" | "timeout";

export interface PanelFinding {
  shape: ReviewShape;
  text: string;
  blocking: boolean;
}

export interface PanelVerdict {
  outcome: PanelOutcome;
  head: string;
  /** In shape order, each labelled with the member that wrote it. */
  findings: readonly PanelFinding[];
  defectClass?: string;
  /** The dissenting member's `Closer:` line. */
  closer?: "yes" | "no";
  /** The members that said FIX_FIRST; only they re-run on the next head. */
  dissent: readonly ReviewShape[];
  degraded: readonly ReviewShape[];
  /** The class is `g10` and the opus correctness member and the adversary both said MERGE at this head, none degraded. */
  satisfiesG10: boolean;
}
