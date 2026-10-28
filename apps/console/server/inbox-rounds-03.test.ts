import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OwnerItem } from "@titan-design/owner-queue";
import { ManifestSchema } from "@titan-design/review-schema";
import { roundQueueItems } from "./approval-items.js";
import { inboxItems, type InboxItem, type WatchRow } from "./inbox-view.js";
import { readQueueRounds } from "./rounds.js";
import { BACKLOG_PRS, BACKLOG_REPO, backlogRound, pinnedHead, roundsDirWith } from "./round-v03.test-helpers.js";

const ROUND = "backlog-ship-r2";
const NOW = Date.parse("2026-10-02T00:00:00.000Z");
const OTHER_HEAD = "f".repeat(40);
const runOf = (pr: number): string => `00000000-0000-4000-8000-0000000000${pr}`;
const gateIdOf = (pr: number): string => `gate:${runOf(pr)}/approve-merge`;

function gate(pr: number): OwnerItem {
  const ref = `${runOf(pr)}/approve-merge`;
  return {
    id: gateIdOf(pr),
    sources: [{ system: "hitl", ref }],
    kind: "approve",
    door: "two-way",
    summary: `Approve merge of #${pr}`,
    context: "",
    keys: [],
    personal: false,
    lens: "blocking-merge",
    unblocks: [],
    openedAt: "2026-10-01T00:00:00.000Z",
    status: "open",
  };
}

/** Shepherd names the repo as GitHub spells it, so the fold must not depend on case. */
function row(pr: number, headSha: string): WatchRow {
  return {
    repo: "Acme/Widgets",
    pr,
    branch: `feat/${pr}`,
    runId: runOf(pr),
    task: "EX-1",
    phase: "awaiting-approval",
    headSha,
    phaseSince: "2026-10-01T00:00:00.000Z",
    nextAction: "owner: resolve approve-merge",
    pendingGate: { gateId: `${runOf(pr)}/approve-merge`, stepId: "approve-merge", since: "2026-10-01T00:00:00.000Z" },
    held: null,
    stalled: null,
  };
}

let dir: string;
let remove: () => Promise<void>;

beforeEach(async () => {
  ({ dir, remove } = await roundsDirWith(ROUND, backlogRound()));
});

afterEach(async () => {
  await remove();
});

async function inbox(gates: readonly OwnerItem[], rows: readonly WatchRow[]): Promise<{ items: InboxItem[]; gaps: string[] }> {
  const read = await readQueueRounds({ dir });
  const queue = roundQueueItems(read.rounds);
  return { items: inboxItems([...queue.open, ...gates], rows, { now: NOW }), gaps: [...read.gaps, ...queue.gaps] };
}

const roundRow = (items: readonly InboxItem[]): InboxItem | undefined => items.find((item) => item.id === `round:${ROUND}`);

describe("a round only review-schema 0.3 reads, in the inbox (TP-4356)", () => {
  it("is one blocking row with its question count and no unreadable-round gap", async () => {
    expect(ManifestSchema.safeParse(backlogRound()).success).toBe(false);

    const { items, gaps } = await inbox([], []);

    expect(gaps).toEqual([]);
    expect(items.map((item) => [item.id, item.section, item.questionCount])).toEqual([[`round:${ROUND}`, "blocking", BACKLOG_PRS.length]]);
    expect(roundRow(items)?.keys).toEqual(expect.arrayContaining(BACKLOG_PRS.map((pr) => `pr:${BACKLOG_REPO}#${pr}@${pinnedHead(pr)}`)));
  });

  it("folds each PR gate at the head the round pins into the round's row", async () => {
    const { items } = await inbox(BACKLOG_PRS.map(gate), BACKLOG_PRS.map((pr) => row(pr, pinnedHead(pr))));

    expect(items.map((item) => item.id)).toEqual([`round:${ROUND}`]);
    expect(roundRow(items)?.foldedGates).toEqual(BACKLOG_PRS.map(gateIdOf));
  });

  it("keeps a PR gate at a head other than the round's pin as its own row", async () => {
    const [pinned, moved] = BACKLOG_PRS;

    const { items } = await inbox([gate(pinned), gate(moved)], [row(pinned, pinnedHead(pinned)), row(moved, OTHER_HEAD)]);

    expect(items.map((item) => item.id).sort()).toEqual([gateIdOf(moved), `round:${ROUND}`]);
    expect(roundRow(items)?.foldedGates).toEqual([gateIdOf(pinned)]);
  });
});
