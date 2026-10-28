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

    const items = inboxItems(order, [], { liveAgents: LIVE_AGENTS });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "round:calib-r2", section: "blocking", questionCount: 3, action: { kind: "open-round", roundId: "calib-r2" } });
    expect(items[0]!.keys).toEqual(["ask:calib-r2/q1", "ask:calib-r2/q2", "ask:calib-r2/q3"]);
    expect(items[0]!.options).toBeUndefined();
  });

  it("keeps a one-question round as its own question's row", () => {
    const items = inboxItems([question("solo-r1", "only")], [], { liveAgents: LIVE_AGENTS });

    expect(items.map((each) => [each.id, each.section, each.questionCount])).toEqual([["round:solo-r1/only", "blocking", undefined]]);
  });
});

describe("sources that never block", () => {
  it("lists a Morning line and an active-work task as planning even when asked as blocking", () => {
    const morning = item("morning:m-1", { sources: [{ system: "morning", ref: "m-1" }], lens: "blocking-merge", seat: LIVE });
    const task = item("task:EX-9", { sources: [{ system: "active-work", ref: "example/EX-9" }], lens: "blocking-agent", asker: LIVE });

    const items = inboxItems([morning, task], [], { liveAgents: LIVE_AGENTS });

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

    const items = inboxItems([deposit(LIVE), deposit(GONE), chat], [], { liveAgents: LIVE_AGENTS });

    expect(sectionsOf(items)).toEqual({ "deposit:live-seat-none": "blocking", "deposit:gone-seat-none": "planning", "chat:msg-1": "planning" });
  });

  it("is planning when the roster was not read, since no asker can be shown live", () => {
    expect(sectionsOf(inboxItems([deposit(LIVE)], []))).toEqual({ "deposit:live-seat-none": "planning" });
  });

  it("blocks on a merge op only at the live run's head, and never for a cleanup op", () => {
    const merge = (headSha: string, pr: number): OwnerOp => ({ kind: "merge-at-head", repo: REPO, pr, headSha });
    const atHead = { ...deposit(GONE, merge(HEAD, 7)), id: "deposit:at-head" };
    const stale = { ...deposit(LIVE, merge(OLD_HEAD, 8)), id: "deposit:stale-head" };
    const close = deposit(LIVE, { kind: "close-pr", repo: REPO, pr: 9, headSha: HEAD });

    const items = inboxItems([atHead, stale, close], [row(), row({ runId: "33333333-0000-4000-8000-000000000003", pr: 8 })], { liveAgents: LIVE_AGENTS });

    expect(sectionsOf(items)).toEqual({ "deposit:at-head": "blocking", "deposit:stale-head": "planning", "deposit:live-seat-close-pr": "planning" });
  });
});

const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const HOUR = 60 * 60_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const RUN_B = "22222222-0000-4000-8000-000000000002";
const sentBack = (runId: string, openedAt: string): OwnerItem =>
  item(`gate:${runId}/sh-sent-back`, { sources: [{ system: "hitl", ref: `${runId}/sh-sent-back` }], kind: "approve", lens: "blocking-merge", openedAt });
const sentBackRow = (runId: string, pr: number): WatchRow => row({ runId, pr, pendingGate: { gateId: `${runId}/sh-sent-back`, stepId: "sh-sent-back", since: ago(HOUR) } });
const mergeAsk = (openedAt: string, pr = 7): OwnerItem => ({ ...deposit(LIVE, { kind: "merge-at-head", repo: REPO, pr, headSha: HEAD }), id: `deposit:merge-${pr}`, openedAt });

describe("one row per PR", () => {
  it("keeps only the newest ask about a PR blocking, so a later deposit replaces the gate it restates", () => {
    const olderGate = { ...gate, openedAt: ago(48 * HOUR) };

    const items = inboxItems([olderGate, mergeAsk(ago(HOUR))], [row()], { liveAgents: LIVE_AGENTS, now: NOW });

    expect(sectionsOf(items)).toEqual({ [gate.id]: "planning", "deposit:merge-7": "blocking" });
  });
});

describe("an sh-sent-back gate", () => {
  it("is the implementer's to clear unless an owner op on its PR asks the owner to act", () => {
    const alone = sentBack(RUN, ago(HOUR));
    const asked = sentBack(RUN_B, ago(HOUR));

    const items = inboxItems([alone, asked, mergeAsk(ago(2 * HOUR), 8)], [sentBackRow(RUN, 7), sentBackRow(RUN_B, 8)], { liveAgents: LIVE_AGENTS, now: NOW });

    expect(sectionsOf(items)).toEqual({ [alone.id]: "planning", [asked.id]: "blocking", "deposit:merge-8": "planning" });
  });
});

describe("a personal deposit", () => {
  it("is planning even when its asker is live", () => {
    const personal = { ...deposit(LIVE), personal: true };

    expect(sectionsOf(inboxItems([personal], [], { liveAgents: LIVE_AGENTS, now: NOW }))).toEqual({ "deposit:live-seat-none": "planning" });
  });
});

describe("an agent-chat approval", () => {
  it("stops blocking a day after it was asked, since its prompt has timed out or been relayed", () => {
    const fresh = item("chat:fresh", { kind: "approve", asker: LIVE, openedAt: ago(23 * HOUR) });
    const stale = item("chat:stale", { kind: "approve", asker: LIVE, openedAt: ago(25 * HOUR) });

    expect(sectionsOf(inboxItems([fresh, stale], [], { liveAgents: LIVE_AGENTS, now: NOW }))).toEqual({ "chat:fresh": "blocking", "chat:stale": "planning" });
  });
});

describe("a blocking item past four days", () => {
  it("stays blocking, marked aged and listed after the fresh blockers", () => {
    const fresh = { ...deposit(LIVE), id: "deposit:fresh", openedAt: ago(HOUR) };
    const old = { ...deposit(LIVE), id: "deposit:old", openedAt: ago(97 * HOUR) };

    const items = inboxItems([old, fresh], [], { liveAgents: LIVE_AGENTS, now: NOW });

    expect(items.map((each) => [each.id, each.section, each.aged])).toEqual([
      ["deposit:fresh", "blocking", undefined],
      ["deposit:old", "blocking", true],
    ]);
  });

  it("keeps a coordinator's merge-at-head ask on a live PR visible as aged blocking, over the older gate it restates", () => {
    const olderGate = { ...gate, openedAt: ago(8 * 24 * HOUR) };
    const ask = mergeAsk(ago(4 * 24 * HOUR + HOUR));

    const items = inboxItems([olderGate, ask], [row()], { liveAgents: LIVE_AGENTS, now: NOW });

    expect(items.find((each) => each.id === "deposit:merge-7")).toMatchObject({ section: "blocking", aged: true, action: { kind: "owner-op" } });
  });
});
