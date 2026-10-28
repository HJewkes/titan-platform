import { describe, expect, it } from "vitest";
import type { OwnerItem, OwnerOp } from "@titan-design/owner-queue";
import { inboxItems, type InboxItem, type WatchRow } from "./inbox-view.js";

const REPO = "example/repo";
const HEAD = "1234567890abcdef1234567890abcdef12345678";
const OLD_HEAD = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
const RUN = "11111111-0000-4000-8000-000000000001";
const GATE = `${RUN}/approve-merge`;
const LIVE = "live-seat";
const GONE = "gone-seat";
const LIVE_AGENTS = new Set([LIVE]);

function item(id: string, overrides: Partial<OwnerItem> = {}): OwnerItem {
  return {
    id,
    sources: [{ system: "agent-chat", ref: id }],
    kind: "decide",
    door: "two-way",
    summary: `Settle ${id}?`,
    context: "",
    keys: [],
    personal: false,
    lens: "blocking-agent",
    unblocks: [],
    openedAt: "2026-10-01T00:00:00.000Z",
    status: "open",
    ...overrides,
  };
}

function row(overrides: Partial<WatchRow> = {}): WatchRow {
  return {
    repo: REPO,
    pr: 7,
    branch: "feat/7",
    runId: RUN,
    task: "EX-1",
    phase: "awaiting-approval",
    headSha: HEAD,
    phaseSince: "2026-10-01T00:00:00.000Z",
    nextAction: "owner: resolve approve-merge",
    pendingGate: { gateId: GATE, stepId: "approve-merge", since: "2026-10-01T00:00:00.000Z" },
    held: null,
    stalled: null,
    ...overrides,
  };
}

const gate = item(`gate:${GATE}`, { sources: [{ system: "hitl", ref: GATE }], kind: "approve", lens: "blocking-merge" });
const deposit = (asker: string, op?: OwnerOp): OwnerItem =>
  item(`deposit:${asker}-${op?.kind ?? "none"}`, { sources: [{ system: "deposit", ref: `${asker}/d-1` }], kind: "do", asker, ...(op && { op }) });
const question = (roundId: string, questionId: string): OwnerItem =>
  item(`round:${roundId}/${questionId}`, { sources: [{ system: "round", ref: `${roundId}#${questionId}` }], kind: "review", lens: "planning", keys: [`ask:${roundId}/${questionId}`], options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });

const sectionsOf = (items: readonly InboxItem[]): Record<string, string> => Object.fromEntries(items.map((each) => [each.id, each.section]));

describe("a multi-question round in the inbox", () => {
  it("is one blocking row carrying its question count and no per-question options", () => {
    const order = [question("calib-r2", "q1"), question("calib-r2", "q2"), question("calib-r2", "q3")];

    const items = inboxItems(order, [], new Map(), LIVE_AGENTS);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "round:calib-r2", section: "blocking", questionCount: 3, action: { kind: "open-round", roundId: "calib-r2" } });
    expect(items[0]!.keys).toEqual(["ask:calib-r2/q1", "ask:calib-r2/q2", "ask:calib-r2/q3"]);
    expect(items[0]!.options).toBeUndefined();
  });

  it("keeps a one-question round as its own question's row", () => {
    const items = inboxItems([question("solo-r1", "only")], [], new Map(), LIVE_AGENTS);

    expect(items.map((each) => [each.id, each.section, each.questionCount])).toEqual([["round:solo-r1/only", "blocking", undefined]]);
  });
});

describe("sources that never block", () => {
  it("lists a Morning line and an active-work task as planning even when asked as blocking", () => {
    const morning = item("morning:m-1", { sources: [{ system: "morning", ref: "m-1" }], lens: "blocking-merge", seat: LIVE });
    const task = item("task:EX-9", { sources: [{ system: "active-work", ref: "example/EX-9" }], lens: "blocking-agent", asker: LIVE });

    const items = inboxItems([morning, task], [], new Map(), LIVE_AGENTS);

    expect(sectionsOf(items)).toEqual({ "morning:m-1": "planning", "task:EX-9": "planning" });
  });
});

describe("a hitl gate in the inbox", () => {
  it("blocks when its live run is pending on it at a PR head", () => {
    expect(sectionsOf(inboxItems([gate], [row()]))).toEqual({ [gate.id]: "blocking" });
  });

  it("is planning when its PR is closed and Shepherd holds no live row for it", () => {
    expect(sectionsOf(inboxItems([gate], []))).toEqual({ [gate.id]: "planning" });
  });

  it("is planning when its live run waits on another gate", () => {
    const moved = row({ pendingGate: { gateId: `${RUN}/approve-merge:2`, stepId: "approve-merge", since: "2026-10-02T00:00:00.000Z" } });

    expect(sectionsOf(inboxItems([gate], [moved]))).toEqual({ [gate.id]: "planning" });
  });
});

describe("a deposit or chat ask in the inbox", () => {
  it("blocks only while its asker is live", () => {
    const chat = item("chat:msg-1", { asker: GONE });

    const items = inboxItems([deposit(LIVE), deposit(GONE), chat], [], new Map(), LIVE_AGENTS);

    expect(sectionsOf(items)).toEqual({ "deposit:live-seat-none": "blocking", "deposit:gone-seat-none": "planning", "chat:msg-1": "planning" });
  });

  it("is planning when the roster was not read, since no asker can be shown live", () => {
    expect(sectionsOf(inboxItems([deposit(LIVE)], []))).toEqual({ "deposit:live-seat-none": "planning" });
  });

  it("blocks on a merge op only at the live run's head, and never for a cleanup op", () => {
    const merge = (headSha: string): OwnerOp => ({ kind: "merge-at-head", repo: REPO, pr: 7, headSha });
    const atHead = { ...deposit(GONE, merge(HEAD)), id: "deposit:at-head" };
    const stale = { ...deposit(LIVE, merge(OLD_HEAD)), id: "deposit:stale-head" };
    const close = deposit(LIVE, { kind: "close-pr", repo: REPO, pr: 7, headSha: HEAD });

    const items = inboxItems([atHead, stale, close], [row()], new Map(), LIVE_AGENTS);

    expect(sectionsOf(items)).toEqual({ "deposit:at-head": "blocking", "deposit:stale-head": "planning", "deposit:live-seat-close-pr": "planning" });
  });
});
