/**
 * Synthetic replays of the 17 owner gates Shepherd opened on 2026-09-29..10-01 (14 approve-merge, 3 main-red). Each
 * fixture keeps only the shape of its gate's run: the mergeable state at each head, the reviews there, and main CI.
 * No real PR, sha, branch, agent name or transcript text appears here; the map to the real gates is kept privately.
 */

/** What one review at a head answers; `held-*` come from the reviewer a hold names, so Shepherd dispatched nobody. */
export type ReviewAnswer = "MERGE" | "FIX_FIRST" | "silent" | "held-MERGE";

export interface HeadScript {
  /** `mergeable_state` when CI is read at this head; `behind` sends land to update-branch before any review. */
  state?: "clean" | "behind" | "blocked" | "dirty";
  /** The owner holds the PR for the fixture's reviewer when this head is first read. */
  hold?: boolean;
  /** The answers to the reviews at this head, in order. */
  reviews?: ReviewAnswer[];
  /** The base moves during the last review at this head, so the PR reads behind after it. */
  goesBehind?: boolean;
  /** This head is the newest reviewed head merged cleanly onto main: the tree probe answers equal and no review is asked. */
  treeEqual?: boolean;
}

/** Main CI at the merge commit: red freezes and fixes, `cancelled-superseded` is read on the newer main push. */
export type MainScript = "green" | "red" | "cancelled-superseded";

/** How a replay settles: merged, paused on a gate, or waiting in the merge step on a hold. */
export type ReplayOutcome = "merged" | "gated" | "held-in-merge";

export interface Pinned {
  outcome: ReplayOutcome;
  /** Pending gates at the end, by escalation name for approve-merge and by step id otherwise. */
  gates: string[];
  /** Reviewers Shepherd dispatched; a held reviewer's answer is not one. */
  reviewers: number;
  /** Fixers spawned for a red main. */
  fixers: number;
}

export interface LedgerFixture {
  id: number;
  gate: "approve-merge" | "main-red";
  story: string;
  heads: HeadScript[];
  main?: MainScript;
  /** The gate's own approval rule is bypassable, so GitHub's `blocked` is no block. */
  reviewBypass?: boolean;
  /** How the replay settles now that TP-737 has landed. */
  today: Pinned;
}

const merged = (reviewers: number, fixers = 0): Pinned => ({ outcome: "merged", gates: [], reviewers, fixers });

export const LEDGER_FIXTURES: readonly LedgerFixture[] = [
  {
    id: 1,
    gate: "approve-merge",
    story: "behind, update, blocked by a bypassable review rule, MERGE",
    heads: [{ state: "behind" }, { state: "blocked", reviews: ["MERGE"] }],
    reviewBypass: true,
    today: merged(1),
  },
  {
    id: 2,
    gate: "approve-merge",
    story: "a reviewer lost to a broker restart, update, MERGE",
    heads: [{ reviews: ["silent"], goesBehind: true }, { reviews: ["MERGE"] }],
    today: merged(2),
  },
  {
    id: 3,
    gate: "approve-merge",
    story: "a silent reviewer, then a fresh reviewer's MERGE",
    heads: [{ reviews: ["silent", "MERGE"] }],
    today: merged(2),
  },
  {
    id: 4,
    gate: "approve-merge",
    story: "behind, update, a silent reviewer, then a fresh reviewer's MERGE",
    heads: [{ state: "behind" }, { reviews: ["silent", "MERGE"] }],
    today: merged(2),
  },
  {
    id: 5,
    gate: "approve-merge",
    story: "FIX_FIRST, a behind fix, MERGE, update, then held for a named reviewer who sends MERGE",
    heads: [{ reviews: ["FIX_FIRST"] }, { state: "behind" }, { reviews: ["MERGE"], goesBehind: true }, { hold: true, reviews: ["held-MERGE"] }],
    today: merged(2),
  },
  {
    id: 6,
    gate: "approve-merge",
    story: "behind, update, MERGE, tree-equal update",
    heads: [{ state: "behind" }, { reviews: ["MERGE"], goesBehind: true }, { treeEqual: true }],
    today: merged(1),
  },
  {
    id: 7,
    gate: "approve-merge",
    story: "two updates, FIX_FIRST, a behind fix, MERGE, tree-equal update",
    heads: [{ state: "behind" }, { state: "behind" }, { reviews: ["FIX_FIRST"] }, { state: "behind" }, { reviews: ["MERGE"], goesBehind: true }, { treeEqual: true }],
    today: merged(2),
  },
  {
    id: 8,
    gate: "approve-merge",
    story: "MERGE, behind, update with new commits, then held for a named reviewer who sends MERGE",
    heads: [{ reviews: ["MERGE"], goesBehind: true }, { hold: true, reviews: ["held-MERGE"] }],
    today: merged(1),
  },
  {
    id: 9,
    gate: "approve-merge",
    story: "two FIX_FIRSTs, MERGE, tree-equal update",
    heads: [{ reviews: ["FIX_FIRST"] }, { reviews: ["FIX_FIRST"] }, { reviews: ["MERGE"], goesBehind: true }, { treeEqual: true }],
    today: merged(3),
  },
  {
    id: 10,
    gate: "approve-merge",
    story: "two FIX_FIRSTs, a conflict the fixer takes, update, MERGE, tree-equal update",
    heads: [{ reviews: ["FIX_FIRST"] }, { reviews: ["FIX_FIRST"] }, { state: "dirty" }, { state: "behind" }, { reviews: ["MERGE"], goesBehind: true }, { treeEqual: true }],
    today: merged(3),
  },
  {
    id: 11,
    gate: "main-red",
    story: "MERGE, then two checks red on main",
    heads: [{ reviews: ["MERGE"] }],
    main: "red",
    today: merged(1, 1),
  },
  {
    id: 12,
    gate: "approve-merge",
    story: "a silent reviewer, two updates, MERGE",
    heads: [{ reviews: ["silent"], goesBehind: true }, { state: "behind" }, { reviews: ["MERGE"] }],
    today: merged(2),
  },
  {
    id: 13,
    gate: "approve-merge",
    story: "three FIX_FIRSTs, update, MERGE, two tree-equal updates",
    heads: [{ reviews: ["FIX_FIRST"] }, { reviews: ["FIX_FIRST"] }, { reviews: ["FIX_FIRST"] }, { state: "behind" }, { reviews: ["MERGE"], goesBehind: true }, { treeEqual: true, goesBehind: true }, { treeEqual: true }],
    today: merged(4),
  },
  {
    id: 14,
    gate: "approve-merge",
    story: "a silent reviewer, three updates, a MERGE read late from the transcript",
    heads: [{ reviews: ["silent"], goesBehind: true }, { state: "behind" }, { state: "behind" }, { reviews: ["MERGE"] }],
    today: merged(2),
  },
  {
    id: 15,
    gate: "main-red",
    story: "MERGE, then main CI cancelled by a newer main push whose run passes",
    heads: [{ reviews: ["MERGE"] }],
    main: "cancelled-superseded",
    today: merged(1),
  },
  {
    id: 16,
    gate: "main-red",
    story: "MERGE, then one check red on main",
    heads: [{ reviews: ["MERGE"] }],
    main: "red",
    today: merged(1, 1),
  },
  {
    id: 17,
    gate: "approve-merge",
    story: "three updates, MERGE, tree-equal update",
    heads: [{ state: "behind" }, { state: "behind" }, { state: "behind" }, { reviews: ["MERGE"], goesBehind: true }, { treeEqual: true }],
    today: merged(1),
  },
];
