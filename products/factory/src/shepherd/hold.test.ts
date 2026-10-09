import { fakeGitHub, fakeSha, githubPort, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { shepherdEventMigration } from "./events.js";
import type { CarryResult } from "./tree-carry.js";
import { MergeHeldError, heldCheck, holdSatisfier, holdingPort, openHeadRead, waitWhileHeld } from "./hold.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { ReviewerAgent, ReviewerMessage } from "./review.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";

const REPO = "octo/demo";
const H1 = fakeSha("head-1");
const H2 = fakeSha("head-2");
const REVIEWER = "rv-sec";

const agent = (name: string, overrides: Partial<ReviewerAgent> = {}): ReviewerAgent => ({
  name,
  agentId: `agent-${name}`,
  sessionId: `session-${name}`,
  presence: "live",
  spawnedBy: "coord",
  predecessor: null,
  ...overrides,
});

const CREW = [agent("coord", { spawnedBy: null }), agent("impl-a"), agent(REVIEWER)];

const verdictAt = (head: string, verdict = "MERGE", pr = 1, repo = REPO): string => `Reviewed.\n\nVerdict: ${verdict}\nPR: ${repo}#${pr}\nHead: ${head}\n`;

interface Rig {
  fake: FakeGitHub;
  port: GitHubPort;
  store: ShepherdStore;
  roster: ReviewerAgent[];
  messages: ReviewerMessage[];
  pr: number;
}

function rig(kind?: string): Rig {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(15)]);
  const store = new ShepherdStore(db);
  const fake = fakeGitHub({ repo: REPO });
  const { number: pr } = fake.addPr({ headSha: H1 });
  store.register({ repo: REPO, pr, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, ...(kind && { kind }) });
  store.recordAuthor("run-1", { agentId: "agent-impl-a", name: "impl-a", role: "implementer" });
  store.hold("run-1", "awaiting a named review", REVIEWER);
  return { fake, port: githubPort(fake.wire), store, roster: [...CREW], messages: [], pr };
}

function say(r: Rig, text: string, from: ReviewerAgent = agent(REVIEWER)): void {
  const writtenAt = r.messages.length + 1;
  r.messages.push({ agentId: from.agentId, sessionId: from.sessionId, writtenAt, text, locator: { sourceId: `line-${writtenAt}` } as unknown as SourceTextLocator });
}

const satisfier = (r: Rig) => holdSatisfier({ store: () => r.store, roster: async () => r.roster, reader: { read: async () => r.messages } });

const guarded = (r: Rig): GitHubPort => holdingPort(r.port, () => r.store, undefined, satisfier(r));

const mergeAt = (r: Rig, sha: string) => guarded(r).merge(REPO, r.pr, sha, "squash");

describe("a hold that names a reviewer", () => {
  it("merges at the sha its reviewer sent MERGE for, with no release command", async () => {
    const r = rig();
    say(r, verdictAt(H1));

    const merged = await mergeAt(r, H1);

    expect(merged.done).toBe(true);
    expect(r.fake.pr(r.pr).merged).toBe(true);
    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdSatisfied: { head: H1, by: { reviewer: REVIEWER, agentId: `agent-${REVIEWER}`, sessionId: `session-${REVIEWER}` } } });
  });

  it("merges when the reviewer writes the repo in a different letter case than the run was registered with", async () => {
    const r = rig();
    say(r, verdictAt(H1, "MERGE", 1, "Octo/Demo"));

    const merged = await mergeAt(r, H1);

    expect(merged.done).toBe(true);
    expect(r.store.byRun("run-1")).toMatchObject({ holdSatisfied: { head: H1 } });
  });

  it("keeps waiting when the MERGE names an older head", async () => {
    const r = rig();
    say(r, verdictAt(H1));
    r.fake.pushHead(r.pr, H2);

    await expect(mergeAt(r, H2)).rejects.toBeInstanceOf(MergeHeldError);
    await expect(mergeAt(r, H1)).rejects.toBeInstanceOf(MergeHeldError);
    expect(r.fake.pr(r.pr).merged).toBe(false);
  });

  it("keeps the hold when a FIX_FIRST follows the MERGE at the same head, and withdraws an earlier satisfaction", async () => {
    const r = rig();
    say(r, verdictAt(H1));
    const held = heldCheck(r.port, () => r.store, undefined, satisfier(r));
    const first = await held(REPO, r.pr, H1);

    say(r, verdictAt(H1, "FIX_FIRST"));

    expect(first).toBeUndefined();
    await expect(mergeAt(r, H1)).rejects.toBeInstanceOf(MergeHeldError);
    expect(r.store.byRun("run-1")?.holdSatisfied).toBeNull();
  });

  it("does not merge when a WAIT strictly follows the MERGE at the same head, and withdraws nothing", async () => {
    const r = rig();
    say(r, verdictAt(H1));
    say(r, verdictAt(H1, "WAIT"));

    await expect(mergeAt(r, H1)).rejects.toBeInstanceOf(MergeHeldError);
    expect(r.store.byRun("run-1")?.holdSatisfied).toBeNull();
  });

  it("merges when a MERGE follows the WAIT at the same head", async () => {
    const r = rig();
    say(r, verdictAt(H1, "WAIT"));
    say(r, verdictAt(H1));

    const merged = await mergeAt(r, H1);

    expect(merged.done).toBe(true);
  });

  it("withdraws a recorded satisfaction when the reviewer then sends WAIT at that head, and merges again after a later MERGE", async () => {
    const r = rig();
    say(r, verdictAt(H1));
    const held = heldCheck(r.port, () => r.store, undefined, satisfier(r));
    await held(REPO, r.pr, H1);
    expect(r.store.byRun("run-1")?.holdSatisfied?.head).toBe(H1);

    say(r, verdictAt(H1, "WAIT"));

    await expect(mergeAt(r, H1)).rejects.toBeInstanceOf(MergeHeldError);
    expect(r.store.byRun("run-1")?.holdSatisfied).toBeNull();
    say(r, verdictAt(H1));
    await expect(mergeAt(r, H1)).resolves.toMatchObject({ done: true });
  });

  it("keeps a satisfaction at the reviewed head when the WAIT names another head", async () => {
    const r = rig();
    say(r, verdictAt(H1));
    const held = heldCheck(r.port, () => r.store, undefined, satisfier(r));
    await held(REPO, r.pr, H1);

    say(r, verdictAt(H2, "WAIT"));
    await held(REPO, r.pr, H1);

    expect(r.store.byRun("run-1")?.holdSatisfied?.head).toBe(H1);
  });

  it("refuses a same-name agent spawned in the implementer's lineage", async () => {
    const r = rig();
    const impostor = agent(REVIEWER, { agentId: "agent-impostor", sessionId: "session-impostor", spawnedBy: "impl-a" });
    r.roster.push(impostor);
    say(r, verdictAt(H1), impostor);

    await expect(mergeAt(r, H1)).rejects.toBeInstanceOf(MergeHeldError);
    expect(r.store.byRun("run-1")?.holdSatisfied).toBeNull();
  });

  it("refuses a reviewer whose agent id the run recorded as an author", async () => {
    const r = rig();
    r.store.recordAuthor("run-1", { agentId: `agent-${REVIEWER}`, name: "impl-a-s1", role: "successor", predecessor: "impl-a" });
    say(r, verdictAt(H1));

    await expect(mergeAt(r, H1)).rejects.toBeInstanceOf(MergeHeldError);
  });

  it("ignores a MERGE block that names another PR or repo", async () => {
    const r = rig();
    say(r, verdictAt(H1, "MERGE", r.pr + 1));
    say(r, verdictAt(H1, "MERGE", r.pr, "octo/other"));

    await expect(mergeAt(r, H1)).rejects.toBeInstanceOf(MergeHeldError);
  });

  it("holds again when a re-hold names another reviewer", async () => {
    const r = rig();
    say(r, verdictAt(H1));
    await heldCheck(r.port, () => r.store, undefined, satisfier(r))(REPO, r.pr, H1);

    r.store.hold("run-1", "a second look", "rv-other");

    await expect(mergeAt(r, H1)).rejects.toBeInstanceOf(MergeHeldError);
    expect(r.store.byRun("run-1")?.holdSatisfied).toBeNull();
  });

  it("still lets a PR merged elsewhere stop waiting, and a closed one too", async () => {
    const r = rig();
    const held = heldCheck(r.port, () => r.store);
    const open = await held(REPO, r.pr, H1);
    r.fake.pr(r.pr).state = "closed";

    expect(open).toBe("awaiting a named review");
    expect(await held(REPO, r.pr, H1)).toBeUndefined();
  });

  it("releases a waiting merge step once the reviewer's MERGE lands", async () => {
    const r = rig();
    let ran = false;
    const route = { match: "merge", runner: { run: async () => ((ran = true), { ok: true as const, output: "{}" }) } };
    const waiting = waitWhileHeld(route as never, heldCheck(r.port, () => r.store, undefined, satisfier(r)), { sleep: async () => say(r, verdictAt(H1)), now: () => 0 }, openHeadRead(r.port));

    const result = await (waiting.runner.run as (i: unknown) => Promise<{ ok: boolean; output?: string }>)({ prompt: JSON.stringify({ repo: REPO, pr: r.pr, sha: H1 }), signal: new AbortController().signal, stepId: "merge", attempt: 0 });

    expect(result.ok).toBe(true);
    expect(ran).toBe(false);
    expect(r.store.heldReason(REPO, r.pr, undefined, H1)).toBeUndefined();
  });
});

const guardedWith = (r: Rig, answer: CarryResult): GitHubPort =>
  holdingPort(r.port, () => r.store, undefined, holdSatisfier({ store: () => r.store, roster: async () => r.roster, reader: { read: async () => r.messages }, carry: async () => answer }));

describe("a satisfied hold across an update of the reviewed head", () => {
  const EQUAL: CarryResult = { equal: true, headTree: "tree-a", mergeTree: "tree-a" };

  /** A rig whose reviewer sent MERGE at H1 and whose PR has since been updated to H2, with the probe answering `answer`. */
  async function updated(kind: string | undefined, answer: CarryResult | undefined) {
    const r = rig(kind);
    const probed: unknown[] = [];
    const carry = answer && (async (input: unknown) => (probed.push(input), answer));
    const satisfy = holdSatisfier({ store: () => r.store, roster: async () => r.roster, reader: { read: async () => r.messages }, carry });
    say(r, verdictAt(H1));
    await satisfy(REPO, r.pr, H1, "main");
    r.fake.pushHead(r.pr, H2);
    return { r, probed, satisfy };
  }

  it("moves to a tree-equal head, for the same reviewer and session, and asks the probe about the satisfied head", async () => {
    const { r, probed, satisfy } = await updated("correctness", EQUAL);

    await satisfy(REPO, r.pr, H2, "main");

    expect(probed).toEqual([{ repo: REPO, baseRef: "main", fromHead: H1, head: H2 }]);
    expect(r.store.byRun("run-1")?.holdSatisfied).toMatchObject({ head: H2, by: { reviewer: REVIEWER, agentId: `agent-${REVIEWER}`, sessionId: `session-${REVIEWER}` } });
  });

  it.each([
    ["a probe that answers not equal", "correctness", { equal: false, headTree: "a", mergeTree: "b" }],
    ["trees that differ", "correctness", { equal: true, headTree: "a", mergeTree: "b" }],
    ["a security PR", "security", EQUAL],
    ["a PR registered without a kind", undefined, EQUAL],
    ["no probe wired", "correctness", undefined],
  ] as const)("stays at the reviewed head for %s", async (_name, kind, answer) => {
    const { r, satisfy } = await updated(kind, answer);

    await satisfy(REPO, r.pr, H2, "main");

    expect(r.store.byRun("run-1")?.holdSatisfied?.head).toBe(H1);
  });

  it("does not carry past a FIX_FIRST at an update nobody asked the hold about", async () => {
    const { r, satisfy } = await updated("correctness", EQUAL);
    say(r, verdictAt(H2, "FIX_FIRST"));
    const H3 = fakeSha("head-3");
    r.fake.pushHead(r.pr, H3);

    await satisfy(REPO, r.pr, H3, "main");

    expect(r.store.byRun("run-1")?.holdSatisfied).toBeNull();
    await expect(guardedWith(r, EQUAL).merge(REPO, r.pr, H3, "squash")).rejects.toBeInstanceOf(MergeHeldError);
    expect(r.fake.pr(r.pr).merged).toBe(false);
  });

  it("does not carry past a WAIT at an update nobody asked the hold about, and keeps the satisfaction at the reviewed head", async () => {
    const { r, satisfy } = await updated("correctness", EQUAL);
    say(r, verdictAt(H2, "WAIT"));
    const H3 = fakeSha("head-3");
    r.fake.pushHead(r.pr, H3);

    await satisfy(REPO, r.pr, H3, "main");

    expect(r.store.byRun("run-1")?.holdSatisfied?.head).toBe(H1);
    await expect(guardedWith(r, EQUAL).merge(REPO, r.pr, H3, "squash")).rejects.toBeInstanceOf(MergeHeldError);
  });

  it.each([["FIX_FIRST", null], ["WAIT", H1]] as const)("does not carry past a mixed-case-repo %s at an update nobody asked the hold about", async (verdict, kept) => {
    const r = rig("correctness");
    const satisfy = holdSatisfier({ store: () => r.store, roster: async () => r.roster, reader: { read: async () => r.messages }, carry: async () => EQUAL });
    say(r, verdictAt(H1, "MERGE", 1, "Octo/Demo"));
    await satisfy(REPO, r.pr, H1, "main");
    r.fake.pushHead(r.pr, H2);
    say(r, verdictAt(H2, verdict, 1, "Octo/Demo"));
    const H3 = fakeSha("head-3");
    r.fake.pushHead(r.pr, H3);

    await satisfy(REPO, r.pr, H3, "main");

    expect(r.store.byRun("run-1")?.holdSatisfied?.head ?? null).toBe(kept);
    await expect(guardedWith(r, EQUAL).merge(REPO, r.pr, H3, "squash")).rejects.toBeInstanceOf(MergeHeldError);
  });

  it("carries again once a MERGE follows the WAIT", async () => {
    const { r, satisfy } = await updated("correctness", EQUAL);
    say(r, verdictAt(H2, "WAIT"));
    say(r, verdictAt(H2));

    await satisfy(REPO, r.pr, H2, "main");

    expect(r.store.byRun("run-1")?.holdSatisfied?.head).toBe(H2);
  });

  it("reads every session under the reviewer's name for a FIX_FIRST", async () => {
    const { r, satisfy } = await updated("correctness", EQUAL);
    const older = agent(REVIEWER, { agentId: "agent-older", sessionId: "session-older" });
    r.roster.splice(r.roster.findIndex((a) => a.name === REVIEWER), 1, older, agent(REVIEWER));
    r.messages.length = 0;
    say(r, verdictAt(H1));
    r.messages.push({ ...r.messages[0]!, agentId: older.agentId, sessionId: older.sessionId, writtenAt: 9, text: verdictAt(H2, "FIX_FIRST") });

    await satisfy(REPO, r.pr, fakeSha("head-3"), "main");

    expect(r.store.byRun("run-1")?.holdSatisfied).toBeNull();
  });

  it("withdraws the satisfaction when the reviewer's newest verdict at the new head is FIX_FIRST", async () => {
    const { r, satisfy } = await updated("correctness", EQUAL);
    say(r, verdictAt(H2, "FIX_FIRST"));

    await satisfy(REPO, r.pr, H2, "main");

    expect(r.store.byRun("run-1")?.holdSatisfied).toBeNull();
  });
});

describe("a run held at registration whose seat sends the reviewed head back", () => {
  const SEAT = "seat-review";
  const OWN = "rv-octo-demo-1";
  const AFTER_HOLD = { done: false, skipped: "held", mergeSha: "" };

  /** Held before any review with the seat's reviewer named, as a g10-review hold is; Shepherd's own reviewer reviews too. */
  function heldAtRegistration(): Rig {
    const r = rig();
    r.store.hold("run-1", "g10-review: +415/-0 diff over 400", SEAT);
    r.roster.push(agent(SEAT), agent(OWN));
    return r;
  }

  type Run = (input: unknown) => Promise<{ ok: boolean; output?: string; error?: string }>;
  const MAX_POLLS = 5;

  /** The step's sleep runs `onPoll` and gives up after MAX_POLLS by aborting, so a wait that never ends fails the test instead of hanging it. */
  function mergeStep(r: Rig, onPoll: (poll: number) => void = () => {}) {
    const probe = { ran: false, polls: 0 };
    const control = new AbortController();
    const sleep = async () => {
      probe.polls += 1;
      if (probe.polls > MAX_POLLS) return control.abort();
      onPoll(probe.polls);
    };
    const route = { match: "merge", runner: { run: async () => ((probe.ran = true), { ok: true as const, output: "{}" }) } };
    const waiting = waitWhileHeld(route as never, heldCheck(r.port, () => r.store, undefined, satisfier(r)), { sleep, now: () => 0 }, openHeadRead(r.port));
    const run = (sha: string) => (waiting.runner.run as Run)({ prompt: JSON.stringify({ repo: REPO, pr: r.pr, sha }), signal: control.signal, stepId: "merge:0", attempt: 0 });
    return { probe, run };
  }

  /** The step gave up still waiting: it neither merged nor answered. */
  function stillWaiting(r: Rig, step: ReturnType<typeof mergeStep>, result: Awaited<ReturnType<Run>>): void {
    expect(result.ok).toBe(false);
    expect(step.probe).toMatchObject({ ran: false, polls: MAX_POLLS + 1 });
    expect(r.fake.pr(r.pr).merged).toBe(false);
  }

  it("does not merge on Shepherd's own MERGE at a head the seat sent back with FIX_FIRST", async () => {
    const r = heldAtRegistration();
    say(r, verdictAt(H1), agent(OWN));
    say(r, verdictAt(H1, "FIX_FIRST"), agent(SEAT));

    await expect(mergeAt(r, H1)).rejects.toBeInstanceOf(MergeHeldError);
    expect(r.store.byRun("run-1")?.holdSatisfied).toBeNull();
  });

  it("does not merge the fix round's head on Shepherd's own MERGE, and merges it on the seat's", async () => {
    const r = heldAtRegistration();
    say(r, verdictAt(H1, "FIX_FIRST"), agent(SEAT));
    r.fake.pushHead(r.pr, H2);
    say(r, verdictAt(H2), agent(OWN));

    await expect(mergeAt(r, H2)).rejects.toBeInstanceOf(MergeHeldError);
    say(r, verdictAt(H2), agent(SEAT));
    await expect(mergeAt(r, H2)).resolves.toMatchObject({ done: true });
  });

  it("ends a merge step waiting at the sent-back head once the seat sends MERGE at the new head, so land reads CI there", async () => {
    const r = heldAtRegistration();
    say(r, verdictAt(H1), agent(OWN));
    say(r, verdictAt(H1, "FIX_FIRST"), agent(SEAT));
    const step = mergeStep(r, () => (r.fake.pushHead(r.pr, H2), say(r, verdictAt(H2), agent(SEAT))));

    const result = await step.run(H1);

    expect(result).toMatchObject({ ok: true });
    expect(step.probe).toMatchObject({ ran: false, polls: 1 });
    expect(JSON.parse(result.output!).result).toEqual(AFTER_HOLD);
    expect(r.fake.pr(r.pr).merged).toBe(false);
  });

  it("ends the merge step at the old head, unmerged and still held, once a push moves the PR on, so land reads CI at the new head", async () => {
    const r = heldAtRegistration();
    const step = mergeStep(r, (poll) => poll === 1 && r.fake.pushHead(r.pr, H2));

    const result = await step.run(H1);

    expect(result).toMatchObject({ ok: true });
    expect(step.probe).toMatchObject({ ran: false, polls: 1 });
    expect(JSON.parse(result.output!).result).toEqual(AFTER_HOLD);
    expect(r.fake.pr(r.pr).merged).toBe(false);
    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdReason: "g10-review: +415/-0 diff over 400" });
  });

  it("keeps the merge step at the new head waiting once a push moves the PR on past the hold reviewer's MERGE", async () => {
    const r = heldAtRegistration();
    say(r, verdictAt(H1), agent(SEAT));
    await heldCheck(r.port, () => r.store, undefined, satisfier(r))(REPO, r.pr, H1);
    r.fake.pushHead(r.pr, H2);
    const step = mergeStep(r);

    stillWaiting(r, step, await step.run(H2));
    expect(r.store.byRun("run-1")?.holdSatisfied?.head).toBe(H1);
  });

  it("keeps the merge step at the new head waiting while only Shepherd's own reviewer has sent MERGE there", async () => {
    const r = heldAtRegistration();
    say(r, verdictAt(H1, "FIX_FIRST"), agent(SEAT));
    r.fake.pushHead(r.pr, H2);
    const step = mergeStep(r, (poll) => poll === 1 && say(r, verdictAt(H2), agent(OWN)));

    stillWaiting(r, step, await step.run(H2));
  });

  it("keeps the merge step at the new head waiting and withdraws the satisfaction when the hold reviewer sends FIX_FIRST there after MERGE at the old", async () => {
    const r = heldAtRegistration();
    say(r, verdictAt(H1), agent(SEAT));
    await heldCheck(r.port, () => r.store, undefined, satisfier(r))(REPO, r.pr, H1);
    r.fake.pushHead(r.pr, H2);
    const step = mergeStep(r, (poll) => poll === 1 && say(r, verdictAt(H2, "FIX_FIRST"), agent(SEAT)));

    stillWaiting(r, step, await step.run(H2));
    expect(r.store.byRun("run-1")?.holdSatisfied).toBeNull();
  });

  it("answers no merge on the owner's release, so land reads CI again before merging", async () => {
    const r = heldAtRegistration();
    const step = mergeStep(r, () => void r.store.release("run-1"));

    const result = await step.run(H1);

    expect(result).toMatchObject({ ok: true });
    expect(step.probe.ran).toBe(false);
    expect(JSON.parse(result.output!).result).toEqual(AFTER_HOLD);
  });
});
