import { fakeGitHub, fakeSha, githubPort, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { shepherdEventMigration } from "./events.js";
import { MergeHeldError, holdSatisfier, holdingPort } from "./hold.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { ReviewerAgent, ReviewerMessage } from "./review.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, holdSlotsMigration, lineageMigration, ownerHoldMigration, shepherdMigration, sliceMigration } from "./store.js";
import type { CarryResult } from "./tree-carry.js";

const REPO = "octo/demo";
const H1 = fakeSha("head-1");
const H2 = fakeSha("head-2");
const REVIEWER = "rv-sec";
const OWNER = "owner-asked: discuss scope; tp#1027";
const G10 = "g10-review: auth change";
const EQUAL: CarryResult = { equal: true, headTree: "tree-a", mergeTree: "tree-a" };

const agent = (name: string, spawnedBy: string | null = "coord"): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence: "live", spawnedBy, predecessor: null });

const verdictAt = (head: string, verdict = "MERGE"): string => `Reviewed.\n\nVerdict: ${verdict}\nPR: ${REPO}#1\nHead: ${head}\n`;

interface Rig {
  fake: FakeGitHub;
  store: ShepherdStore;
  messages: ReviewerMessage[];
  guarded: GitHubPort;
}

/** tp#1027 on the `--reviewer` route: the seat names its reviewer, and the merge guard reads that reviewer's verdicts, carrying a MERGE to a tree-equal head. */
function rig(order: "owner-first" | "reviewer-first"): Rig {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), ownerHoldMigration(22)]);
  const store = new ShepherdStore(db);
  const fake = fakeGitHub({ repo: REPO });
  fake.addPr({ headSha: H1 });
  store.register({ repo: REPO, pr: 1, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind: "correctness" });
  store.recordAuthor("run-1", { agentId: "agent-impl-a", name: "impl-a", role: "implementer" });
  const holds = [() => store.hold("run-1", OWNER), () => store.hold("run-1", G10, REVIEWER)];
  (order === "owner-first" ? holds : holds.reverse()).forEach((hold) => hold());
  const messages: ReviewerMessage[] = [];
  const roster = [agent("coord", null), agent("impl-a"), agent(REVIEWER)];
  const satisfy = holdSatisfier({ store: () => store, roster: async () => roster, reader: { read: async () => messages }, carry: async () => EQUAL });
  return { fake, store, messages, guarded: holdingPort(githubPort(fake.wire), () => store, undefined, satisfy) };
}

const locatorOf = (sessionId: string): SourceTextLocator => ({
  source: {
    sourceId: `transcript-${sessionId}`,
    harness: "claude-code",
    format: "jsonl",
    formatVersion: null,
    path: `/transcripts/${sessionId}.jsonl`,
    namespace: "test",
    conversation: { harness: "claude-code", namespace: "test", nativeId: sessionId },
    provenance: { kind: "native", name: "test" },
  },
  evidence: {
    line: { sourceId: `transcript-${sessionId}`, byteOffset: 0, byteLength: 1, contentHash: "0".repeat(64), lineNumber: 1, nativeOrdinal: null },
    subrecord: { index: 0, path: [] },
  },
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] },
});

function say(r: Rig, text: string): void {
  const writtenAt = r.messages.length + 1;
  r.messages.push({ agentId: `agent-${REVIEWER}`, sessionId: `session-${REVIEWER}`, writtenAt, text, locator: locatorOf(`session-${REVIEWER}`) });
}

const mergeAt = (r: Rig, sha: string) => r.guarded.merge(REPO, 1, sha, "squash");

describe("tp#1027 on the --reviewer route: an owner hold and a named reviewer's MERGE at the head", () => {
  it.each(["owner-first", "reviewer-first"] as const)("records the MERGE and still refuses the merge, %s", async (order) => {
    const r = rig(order);
    say(r, verdictAt(H1));

    const merge = mergeAt(r, H1);

    await expect(merge).rejects.toThrow(MergeHeldError);
    await expect(merge).rejects.toThrow(/owner-asked/);
    expect(r.fake.pr(1).merged).toBe(false);
    expect(r.store.byRun("run-1")?.holdSatisfied?.head).toBe(H1);
  });

  it("stays held after the satisfaction is carried to a tree-equal head", async () => {
    const r = rig("owner-first");
    say(r, verdictAt(H1));
    await expect(mergeAt(r, H1)).rejects.toThrow(MergeHeldError);
    r.fake.pushHead(1, H2);

    await expect(mergeAt(r, H2)).rejects.toThrow(MergeHeldError);

    expect(r.store.byRun("run-1")?.holdSatisfied?.head).toBe(H2);
    expect(r.fake.pr(1).merged).toBe(false);
  });

  it("stays held after the g10-review hold is released, and merges only once the owner releases", async () => {
    const r = rig("owner-first");
    say(r, verdictAt(H1));
    r.store.releaseClass("run-1", "g10-review");

    await expect(mergeAt(r, H1)).rejects.toThrow(MergeHeldError);
    r.store.releaseOwnerHold("run-1", { actor: "owner-terminal:test" });
    const merged = await mergeAt(r, H1);

    expect(merged.done).toBe(true);
    expect(r.fake.pr(1).merged).toBe(true);
  });

  it("merges on the satisfied MERGE once the owner releases, with the reviewer hold kept", async () => {
    const r = rig("reviewer-first");
    say(r, verdictAt(H1));
    await expect(mergeAt(r, H1)).rejects.toThrow(MergeHeldError);

    r.store.releaseOwnerHold("run-1", { actor: "owner-terminal:test" });
    const merged = await mergeAt(r, H1);

    expect(merged.done).toBe(true);
    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdReason: G10, ownerHold: null });
  });

  it("withdraws the satisfaction on a later FIX_FIRST and keeps the owner hold", async () => {
    const r = rig("owner-first");
    say(r, verdictAt(H1));
    await expect(mergeAt(r, H1)).rejects.toThrow(MergeHeldError);
    say(r, verdictAt(H1, "FIX_FIRST"));

    await expect(mergeAt(r, H1)).rejects.toThrow(MergeHeldError);

    expect(r.store.byRun("run-1")).toMatchObject({ holdSatisfied: null, ownerHold: { reason: OWNER } });
  });
});
