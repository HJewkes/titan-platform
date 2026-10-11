import type { OwnerItem } from "@titan-design/owner-queue";
import type { DecisionTask } from "../needs/active-work-source.js";

/**
 * A synthetic owner queue with the 10-05 snapshot's shape: 36 pending gates, 88 Morning items over four seats
 * and 145 needs-decision tasks. Every name is invented; the planted overlaps are listed in OVERLAP_LINES.
 */
export const GATE_COUNT = 36;
export const MORNING_COUNT = 88;
export const TASK_COUNT = 145;
export const SEATS = ["seat-a", "seat-b", "seat-c", "seat-d"] as const;

const pad = (n: number, width: number): string => String(n).padStart(width, "0");
const shaOf = (n: number): string => pad(n, 2).repeat(20);
const runOf = (n: number): string => `00000000-0000-4000-8000-${pad(n, 12)}`;

/** A pending hitl gate as the factory's gate adapter emits it: exact PR head, gate, run and task keys. */
export function gateItem(n: number): OwnerItem {
  const id = `gate:g-${pad(n, 2)}`;
  return {
    id,
    sources: [{ system: "hitl", ref: `g-${pad(n, 2)}` }],
    kind: "approve",
    door: "one-way",
    summary: `widgets#${100 + n} approve-merge`,
    context: "",
    keys: [`pr:acme/widgets#${100 + n}@${shaOf(n)}`, id, `run:${runOf(n)}`, `task:W-${500 + n}`],
    personal: false,
    lens: "blocking-merge",
    unblocks: [],
    openedAt: "2026-10-05T08:00:00Z",
    status: "open",
  };
}

export function decisionTask(n: number): DecisionTask {
  return { slug: "demo", id: `D-${1000 + n}`, title: `Choose option set ${n}`, status: "open", tags: ["needs-decision"], created: "2026-10-01", updated: "2026-10-05" };
}

/** The first lines of each seat's Morning section; each names one gate or task in a different way. */
const PLANTED: Record<(typeof SEATS)[number], string[]> = {
  "seat-a": [
    `**widgets#101:** merge \`acme/widgets 101 ${shaOf(1)} ~/src/widgets\` (two-way). Rec: merge.`,
    "widgets#102 at 0202020: CI red on a known flake (two-way). Rec: rerun.",
  ],
  "seat-b": ["W-503 needs your visual pass before its gate (one-way). Rec: look today."],
  "seat-c": [`Unstick the run: \`titan-factory gate resolve ${runOf(4)} ci-failed\``],
  "seat-d": ["D-1007 pick a storage engine (one-way). Rec: sqlite.", "W-506 and widgets#105 wait on one answer (two-way). Rec: approve both."],
};

export const OVERLAP_LINES = [
  "pr:widgets#101: hitl gate:g-01, morning morning:seat-a:1 (merged)",
  "pr:widgets#102: hitl gate:g-02, morning morning:seat-a:2 (not merged: no shared exact key)",
  "pr:widgets#105: hitl gate:g-05, morning morning:seat-d:2 (not merged: no shared exact key)",
  `run:${runOf(4)}: hitl gate:g-04, morning morning:seat-c:1 (merged)`,
  "task:D-1007: morning morning:seat-d:1, active-work task:D-1007 (merged)",
  "task:W-503: hitl gate:g-03, morning morning:seat-b:1 (merged)",
  "task:W-506: hitl gate:g-06, morning morning:seat-d:2 (merged)",
];

/** One seat's queue file: an In flight section the owner never sees, then 22 Morning items. */
export function seatQueueFile(seat: (typeof SEATS)[number]): string {
  const planted = PLANTED[seat];
  const filler = Array.from({ length: MORNING_COUNT / SEATS.length - planted.length }, (_, i) => `Pick a default for option ${i + 1} (two-way). Rec: keep it.`);
  const items = [...planted, ...filler].map((text, i) => `${i + 1}. ${text}`);
  return [`# Queue: ${seat}`, "", "## In flight", "", "1. busy with widgets#999.", "", "## Morning queue (owner only)", "", ...items, ""].join("\n");
}
