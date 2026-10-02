import { fakeGitHub, fakeSha, githubPort, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { MergeHeldError, heldCheck, holdSatisfier, holdingPort, waitWhileHeld } from "./hold.js";
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

function rig(): Rig {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11)]);
  const store = new ShepherdStore(db);
  const fake = fakeGitHub({ repo: REPO });
  const { number: pr } = fake.addPr({ headSha: H1 });
  store.register({ repo: REPO, pr, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
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
    const waiting = waitWhileHeld(route as never, heldCheck(r.port, () => r.store, undefined, satisfier(r)), { sleep: async () => say(r, verdictAt(H1)), now: () => 0 });

    const result = await (waiting.runner.run as (i: unknown) => Promise<{ ok: boolean; output?: string }>)({ prompt: JSON.stringify({ repo: REPO, pr: r.pr, sha: H1 }), signal: new AbortController().signal, stepId: "merge", attempt: 0 });

    expect(result.ok).toBe(true);
    expect(ran).toBe(false);
    expect(r.store.heldReason(REPO, r.pr, undefined, H1)).toBeUndefined();
  });
});
