import { createHash } from "node:crypto";
import { evaluate } from "@titan-design/authority";
import type * as Authority from "@titan-design/authority";
import { FakeHttpError, fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type GitHubPort, type PrFile } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import type { RoutedStepInput } from "@titan-design/workflow";
import { gateId, gateOpened } from "../test-support/land.js";
import { LAND_STEPS, land, landRoutes } from "../workflows/land.js";
import { MERGE_EVIDENCE_STEP, collectMergeFacts, decideAutoMerge, evidenceComment, evidenceMarker, locatorReference, mergeEvidence, noFreezeStoreUntilTp523, registeredKind, type MergeEvidence, type MergeEvidenceInput } from "./merge-facts.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import { shepherdLandOptions, type EffectivePolicy } from "./policy.js";
import { REVIEW_STEPS, mergeVerdict, reviewRoutes } from "./review.js";
import type { RemergeResult } from "./remerge-carry.js";
import type { CarryResult } from "./tree-carry.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, shepherdMigration, shepherdStoreRef, sliceMigration, type ShepherdStoreRef, type TaskKind } from "./store.js";
import { OWNER } from "../test-support/resolver.js";

vi.mock("@titan-design/authority", async (importOriginal) => {
  const actual = await importOriginal<typeof Authority>();
  return { ...actual, evaluate: vi.fn(actual.evaluate) };
});

const REPO = "octo/demo";
const HEAD = fakeSha("merge-facts-head");
const OTHER_HEAD = fakeSha("merge-facts-other-head");
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const AUTO: EffectivePolicy = { merge: "auto", mergeMethod: "squash", fixer: true, seat: "trusted-seat" };
const locator = { sourceId: "transcript-1", selector: { kind: "subrecord-text" } } as unknown as SourceTextLocator;
const ALLOW_ALL = { verdict: "allow", ruleId: "MRG-AU-RV" } as const;

const input: MergeEvidenceInput = {
  runId: "run-1",
  repo: REPO,
  pr: 1,
  head: HEAD,
  verdict: { value: "MERGE", head: HEAD, locator },
  resolver: REVIEWER,
  dispatchedReviewer: REVIEWER,
  seatGrants: ["merge-on-green-approve"],
};

/** An open PR at HEAD whose required contexts are green from GitHub Actions and whose test merge is clean. */
function world(files: PrFile[] = [{ path: "src/a.ts", status: "modified" }]): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(1, files);
  return fake;
}

async function collect(fake: FakeGitHub, overrides: Partial<MergeEvidenceInput> = {}, kind: string | null = "correctness") {
  return mergeEvidence(githubPort(fake.wire), { ...input, ...overrides }, noFreezeStoreUntilTp523, kind === null ? {} : { kind });
}

afterEach(() => vi.mocked(evaluate).mockReset());

const HOSTNAME = "host-a.example";
const TRANSCRIPT_PATH = "/srv/agents/sessions/s-1.jsonl";
const hostLocator = {
  source: { sourceId: `claude-code:${HOSTNAME}:s-1`, path: TRANSCRIPT_PATH, namespace: HOSTNAME, conversation: { harness: "claude-code", namespace: HOSTNAME, nativeId: "s-1" } },
  evidence: { line: { sourceId: `claude-code:${HOSTNAME}:s-1`, byteOffset: 4096, byteLength: 80, contentHash: "abc", lineNumber: 7, nativeOrdinal: null }, subrecord: { index: 2, path: ["message"] } },
  selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"], textIndex: 1 },
} as unknown as SourceTextLocator;

describe("evidenceComment", () => {
  const record = async () => (await collect(world(), { verdict: { value: "MERGE", head: HEAD, locator: hostLocator } })).record;

  it("posts neither the hostname, the transcript path nor any substring starting with a slash", async () => {
    const body = evidenceComment(await record());

    expect(body).not.toContain(HOSTNAME);
    expect(body).not.toContain(TRANSCRIPT_PATH);
    expect(body).not.toContain("/srv");
    expect(body).not.toMatch(/(^|[^\w`<>!-])\/[\w.-]/m);
  });

  it("names the session, record offset and part so a local reader can find the message, and hashes the full locator", async () => {
    const body = evidenceComment(await record());

    expect(body).toContain('"sessionId": "s-1"');
    expect(body).toContain('"byteOffset": 4096');
    expect(body).toContain('"subrecordIndex": 2');
    expect(body).toContain('"textIndex": 1');
    expect(body).toContain(`"locatorSha256": "${createHash("sha256").update(JSON.stringify(hostLocator)).digest("hex")}"`);
  });

  it("leaves the stored record's locator whole", async () => {
    expect((await record()).verdictLocator).toBe(hostLocator);
  });
});

describe("locatorReference", () => {
  const withSource = (source: object, rest: object = {}) => ({ source: { sourceId: `claude-code:${HOSTNAME}:s-1`, path: TRANSCRIPT_PATH, ...source }, ...rest }) as unknown as SourceTextLocator;

  it("posts unknown for a locator with no nativeId, not its path or source id", () => {
    const reference = locatorReference(withSource({ conversation: { harness: "claude-code" } }));

    expect(reference.sessionId).toBe("unknown");
    expect(JSON.stringify(reference)).not.toContain(HOSTNAME);
    expect(JSON.stringify(reference)).not.toContain("srv");
  });

  it.each(["host/a", "user@host", "../s-1", "..", "C:\\work\\s-1", "a%2Fb", "a".repeat(65), 7])("drops a session id that is not a plain string: %s", (nativeId) => {
    expect(locatorReference(withSource({ conversation: { nativeId } })).sessionId).toBe("unknown");
  });

  it("keeps a UUID session id", () => {
    const nativeId = "123e4567-e89b-42d3-a456-426614174000";

    expect(locatorReference(withSource({ conversation: { nativeId } })).sessionId).toBe(nativeId);
  });

  it("drops positions that are not integers", () => {
    const reference = locatorReference(withSource({ conversation: { nativeId: "s-1" } }, { evidence: { line: { byteOffset: "/srv/x" }, subrecord: { index: 1.5 } }, selector: { textIndex: 3 } }));

    expect(reference).toMatchObject({ sessionId: "s-1", textIndex: 3 });
    expect(reference).not.toHaveProperty("byteOffset");
    expect(reference).not.toHaveProperty("subrecordIndex");
  });
});

describe("collectMergeFacts check apps", () => {
  const SHEPHERD_APP = 4242;
  const observe = (reviewAppId?: number) => collectMergeFacts(githubPort(world().wire), input, noFreezeStoreUntilTp523, {}, undefined, reviewAppId);

  it("trusts GitHub Actions and gives shepherd/review no app when none is configured", async () => {
    const { merge } = await observe();

    expect(merge.allowedApps).toEqual([15368]);
    expect(merge.contextApps).toEqual({ "shepherd/review": [] });
  });

  it("binds shepherd/review to the configured App and leaves allowedApps alone", async () => {
    const { merge } = await observe(SHEPHERD_APP);

    expect(merge.allowedApps).toEqual([15368]);
    expect(merge.contextApps).toEqual({ "shepherd/review": [SHEPHERD_APP] });
  });
});

describe("mergeEvidence", () => {
  it("allows by authority/MRG-AU-RV when all eight conditions hold, and posts one comment carrying the record", async () => {
    const fake = world();

    const evidence = await collect(fake);

    expect(evidence.record.decision).toMatchObject({ outcome: "allow", rule: { table: "authority", rowId: "MRG-AU-RV" } });
    expect(evidence.record).toMatchObject({ head: HEAD, baseRef: "main", testMergeSha: fakeSha("test-merge"), reviewer: REVIEWER, verdictLocator: locator });
    expect(evidence.record.checkRuns).toEqual([
      { name: "validate", id: 1, appId: 15368, conclusion: "success" },
      { name: "dag-check", id: 2, appId: 15368, conclusion: "success" },
    ]);
    const comments = fake.comments.get(1) ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body.split("\n")[0]).toBe(evidenceMarker(HEAD));
    expect(comments[0]!.body).toContain('"rowId": "MRG-AU-RV"');
  });

  it("posts the evidence comment body, with the locator reduced to a reference", async () => {
    const fake = world();

    const evidence = await collect(fake, { verdict: { value: "MERGE", head: HEAD, locator: hostLocator } });

    const body = fake.comments.get(1)![0]!.body;
    expect(body).toBe(evidenceComment(evidence.record));
    expect(body).not.toContain(HOSTNAME);
    expect(body).toContain('"locatorSha256"');
  });

  it("posts no second comment when the step repeats or another run collects at the same head", async () => {
    const fake = world();

    await collect(fake);
    await collect(fake);
    await collect(fake, { runId: "run-2" });

    expect(fake.comments.get(1)).toHaveLength(1);
  });

  it("gates, not allows, when a required context is still pending at the head", async () => {
    const fake = world();
    fake.setRuns(HEAD, [successRun("validate", 1, undefined, null as unknown as string), successRun("dag-check", 2)]);

    const evidence = await collect(fake);

    expect(evidence.record.decision.outcome).toBe("gate");
    expect(evidence.record.decision.reason).toContain("required-contexts-green");
  });

  it("does not count a check run named like a required context from an app other than GitHub Actions", async () => {
    const fake = world();
    fake.setRuns(HEAD, [successRun("validate", 1, undefined, "success", 999), successRun("dag-check", 2)]);

    expect((await collect(fake)).record.decision.outcome).toBe("gate");
  });

  it("allows a release workflow change when authority allows and required checks are green (TP-1886)", async () => {
    const fake = world([{ path: ".github/workflows/release.yml", status: "modified" }]);
    vi.mocked(evaluate).mockReturnValue(ALLOW_ALL);

    const evidence = await collect(fake);

    expect(evidence.record.decision).toMatchObject({ outcome: "allow", rule: { table: "authority" } });
  });

  it("collects the source of a rename, so a move out of .github/ is visible to authority", async () => {
    const fake = world([{ path: "tools/x.yml", previousPath: ".github/actions/x.yml", status: "renamed" }]);

    const evidence = await collect(fake);

    expect(evidence.merge.changedPaths).toEqual(["tools/x.yml", ".github/actions/x.yml"]);
    vi.mocked(evaluate).mockReturnValueOnce(ALLOW_ALL);
    expect(decideAutoMerge(HEAD, evidence).outcome).toBe("allow");
  });

  it("gates facts collected at one head when the decision is for another", async () => {
    const evidence = await collect(world());

    expect(decideAutoMerge(HEAD, evidence).outcome).toBe("allow");
    expect(decideAutoMerge(OTHER_HEAD, evidence)).toMatchObject({ outcome: "gate", rule: { rowId: "head-mismatch" } });
  });

  it("reports the test merge unclean once the head has moved past the reviewed one", async () => {
    const fake = world();
    fake.pushHead(1, OTHER_HEAD);

    const evidence = await collect(fake);

    expect(evidence.merge.mergeTreeClean).toBe(false);
    expect(evidence.record.decision.outcome).toBe("gate");
  });

  describe("a push between the PR read and the changed-files read", () => {
    /** The push lands as the file list is read, so GitHub answers with the new head's files. */
    function pushedDuringRead(fake: FakeGitHub, nextFiles: PrFile[]): GitHubPort {
      const port = githubPort(fake.wire);
      return {
        ...port,
        listPrFiles: async (repo, number) => {
          fake.pushHead(1, OTHER_HEAD);
          fake.prFiles.set(1, nextFiles);
          return port.listPrFiles(repo, number);
        },
      };
    }

    it.each([
      ["a visual change", [{ path: "packages/ui/src/Button.tsx", status: "modified" }], { visualPaths: ["packages/ui/**"] }],
      ["a .github change", [{ path: ".github/workflows/ci.yml", status: "modified" }], {}],
    ])("gates %s at the reviewed head instead of judging the pushed head's files", async (_case, headFiles: PrFile[], overrides: Partial<MergeEvidenceInput>) => {
      const fake = world(headFiles);
      const port = pushedDuringRead(fake, [{ path: "src/a.ts", status: "modified" }]);

      const evidence = await mergeEvidence(port, { ...input, ...overrides }, noFreezeStoreUntilTp523, { kind: "correctness" });

      expect(evidence.merge.changedPaths).toEqual([]);
      expect(evidence.changedFilesUnread).toBe(`the changed files of ${REPO}#1 are unknown: the head moved to ${OTHER_HEAD} during the read`);
      expect(evidence.record.decision).toMatchObject({ outcome: "gate", rule: { rowId: "files-unread" } });
    });

    it("reads no file list when the PR is already at another head", async () => {
      const fake = world();
      fake.pushHead(1, OTHER_HEAD);

      const evidence = await collect(fake);

      expect(fake.calls).not.toContain("listPrFiles");
      expect(evidence.changedFilesUnread).toBe(`the changed files of ${REPO}#1 are unknown: the PR is at ${OTHER_HEAD}, not ${HEAD}`);
    });
  });

  describe("an unknown mergeable_state", () => {
    function scripted(states: string[]): { port: GitHubPort; reads: () => number; sleeps: number[] } {
      const fake = world();
      fake.reviewBypass = true;
      const real = githubPort(fake.wire);
      let reads = 0;
      let settleReads: number | undefined;
      const getPr: GitHubPort["getPr"] = async (repo, number) => ({ ...(await real.getPr(repo, number)), mergeableState: states[Math.min(reads++, states.length - 1)]! });
      // The changed-files read re-reads the head afterwards; that read is not part of settling.
      const listPrFiles: GitHubPort["listPrFiles"] = async (repo, number) => ((settleReads ??= reads), real.listPrFiles(repo, number));
      return { port: { ...real, getPr, listPrFiles }, reads: () => settleReads ?? reads, sleeps: [] };
    }
    const settle = (rig: ReturnType<typeof scripted>) => mergeEvidence(rig.port, input, noFreezeStoreUntilTp523, { kind: "correctness" }, { sleep: async (ms) => void rig.sleeps.push(ms) });

    it("settles to blocked on the second read and allows MRG-AU-RV through a bypassable review rule", async () => {
      const rig = scripted(["unknown", "blocked"]);

      const evidence = await settle(rig);

      expect(rig.reads()).toBe(2);
      expect(rig.sleeps).toEqual([5_000]);
      expect(evidence.record.mergeableState).toBe("blocked");
      expect(evidence.record.decision).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" } });
    });

    it("gates, naming the state, when all three reads are unknown", async () => {
      const rig = scripted(["unknown"]);

      const evidence = await settle(rig);

      expect(rig.reads()).toBe(3);
      expect(rig.sleeps).toEqual([5_000, 5_000]);
      expect(evidence.record.mergeableState).toBe("unknown");
      expect(evidence.record.decision).toMatchObject({ outcome: "gate", reason: "mergeable_state unknown after 3 reads" });
    });

    it("judges any other state on the first read", async () => {
      const rig = scripted(["clean"]);

      await settle(rig);

      expect(rig.reads()).toBe(1);
      expect(rig.sleeps).toEqual([]);
    });
  });

  describe("a blocked PR", () => {
    function blocked(state: "blocked" | "dirty", bypass: boolean): FakeGitHub {
      const fake = world();
      fake.pr(1).mergeableState = state;
      fake.reviewBypass = bypass;
      return fake;
    }

    it("is mergeTreeClean and holds MRG-AU-RV when only a bypassable review rule blocks it", async () => {
      const evidence = await collect(blocked("blocked", true));

      expect(evidence.merge.mergeTreeClean).toBe(true);
      expect(evidence.record.decision).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" } });
    });

    it("is not mergeTreeClean when the review rule cannot be bypassed", async () => {
      expect((await collect(blocked("blocked", false))).merge.mergeTreeClean).toBe(false);
    });

    it("is not mergeTreeClean when it conflicts, even if the review rule is bypassable", async () => {
      expect((await collect(blocked("dirty", true))).merge.mergeTreeClean).toBe(false);
    });

    it("gates, never allows, when the bypass read throws", async () => {
      const fake = blocked("blocked", true);
      fake.wire.reviewRulesBypassable = async () => {
        throw new Error("rulesets unreadable");
      };

      const evidence = await collect(fake);

      expect(evidence.merge.mergeTreeClean).toBe(false);
      expect(evidence.record.decision.outcome).toBe("gate");
    });
  });

  it("gates a resolver that is not the dispatched reviewer", async () => {
    const evidence = await collect(world(), { resolver: { agentId: "agent-other", sessionId: REVIEWER.sessionId } });

    expect(evidence.record.decision.reason).toContain("resolver-is-dispatched-reviewer");
  });

  it("gates a truncated file list instead of deciding from part of the diff", async () => {
    const fake = world();
    fake.prChangedFiles.set(1, 5);

    const evidence = await collect(fake);

    expect(evidence.merge.changedPaths).toEqual([]);
    expect(evidence.record.decision.outcome).toBe("gate");
  });
});

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A workflow that takes the MERGE review through the sh-merge-evidence step, then lands with the Shepherd options. */
function shepherdHost(fake: FakeGitHub, beforeLand: () => void = () => undefined): FactoryHost {
  const port = githubPort(fake.wire, { sleep: async () => undefined });
  let clock = 0;
  const deps: ShepherdDeps = { port, store: shepherdStoreRef(), now: () => clock, sleep: async (ms) => void (clock += ms), agentChatBin: "agent-chat" };
  const run = async (ctx: Parameters<typeof mergeVerdict>[0]) => {
    const reviews = new Map<string, Verdict>([[HEAD, await mergeVerdict(ctx, input)]]);
    beforeLand();
    await land(ctx, { repo: REPO, pr: 1 }, shepherdLandOptions(() => AUTO, (headSha) => reviews.get(headSha)));
  };
  const workflow = defineWorkflow({ name: "shepherd-merge", steps: [...LAND_STEPS, ...REVIEW_STEPS], run });
  const routes = [...landRoutes({ port, now: deps.now, sleep: deps.sleep }), ...reviewRoutes(deps)];
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [workflow], routes, gatePollMs: 5 });
  hosts.push(host);
  return host;
}

const CARRIED_FROM = fakeSha("merge-facts-reviewed-head");
const TREE = fakeSha("merge-facts-tree");

/** A MERGE at CARRIED_FROM, with the sh-carry output for HEAD. */
function carried(result: CarryResult = { equal: true, headTree: TREE, mergeTree: TREE }): Partial<MergeEvidenceInput> {
  return { verdict: { value: "MERGE", head: CARRIED_FROM, locator }, carry: { fromHead: CARRIED_FROM, head: HEAD, result } };
}

describe("a carried verdict", () => {
  it("allows by authority/MRG-AU-RC when the sh-carry output reports equal trees for this head", async () => {
    const evidence = await collect(world(), carried());

    expect(evidence.merge.carry).toEqual({ fromHead: CARRIED_FROM, head: HEAD, headTree: TREE, mergeTree: TREE, rule: "tree-equal" });
    expect(evidence.record.decision).toMatchObject({ outcome: "allow", rule: { table: "authority", rowId: "MRG-AU-RC" } });
  });

  it("still allows an exact-head verdict by MRG-AU-RV and records no carry without sh-carry output", async () => {
    const evidence = await collect(world());

    expect(evidence.merge).not.toHaveProperty("carry");
    expect(evidence.record.decision).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" } });
  });

  it.each(["security", "unknown", null])("gates a carried verdict of registered kind %s", async (kind) => {
    const evidence = await collect(world(), carried(), kind);

    expect(evidence.record.decision.outcome).toBe("gate");
  });

  it("records the registered kind as a fact and still allows an exact-head verdict of kind security by MRG-AU-RV", async () => {
    const evidence = await collect(world(), {}, "security");

    expect(evidence.merge.kind).toBe("security");
    expect(evidence.record.decision).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RV" } });
  });

  it.each([
    ["no sh-carry output", {}],
    ["a probe that found the trees unequal", carried({ equal: false, reason: "trees differ" })],
    ["an equal probe with no trees", carried({ equal: true })],
    ["trees that differ", carried({ equal: true, headTree: TREE, mergeTree: fakeSha("other-tree") })],
    ["a probe answer for a different head", { ...carried(), carry: { fromHead: CARRIED_FROM, head: OTHER_HEAD, result: { equal: true, headTree: TREE, mergeTree: TREE } } }],
    ["a carry from a head other than the verdict's", { ...carried(), verdict: { value: "MERGE" as const, head: OTHER_HEAD, locator } }],
  ])("gates on %s", async (_name, overrides) => {
    const evidence = await collect(world(), { verdict: { value: "MERGE", head: CARRIED_FROM, locator }, ...overrides });

    expect(evidence.record.decision.outcome).toBe("gate");
  });
});

const REMERGE_TREE = fakeSha("merge-facts-remerge-tree");

/** A MERGE at CARRIED_FROM, carried to HEAD by a remerge whose diff touched only a generated file. */
function remerged(remerge: Partial<RemergeResult> = {}): Partial<MergeEvidenceInput> {
  const answer: RemergeResult = { carries: true, rule: "remerge-generated-only", headTree: TREE, remergeTree: REMERGE_TREE, paths: ["CAPABILITIES.md"], generatedPaths: ["CAPABILITIES.md"], ...remerge };
  const result: CarryResult = { equal: false, reason: "trees differ" };
  return { verdict: { value: "MERGE", head: CARRIED_FROM, locator }, carry: { fromHead: CARRIED_FROM, head: HEAD, result, rule: "remerge-generated-only", remerge: answer } };
}

describe("a verdict carried across a remerge", () => {
  it("allows by authority/MRG-AU-RM and records the rule and the paths the merge touched", async () => {
    const evidence = await collect(world([{ path: "src/a.ts", status: "modified" }, { path: "CAPABILITIES.md", status: "modified" }]), remerged());

    expect(evidence.merge.carry).toEqual({ fromHead: CARRIED_FROM, head: HEAD, headTree: TREE, mergeTree: REMERGE_TREE, rule: "remerge-generated-only", remergePaths: ["CAPABILITIES.md"], generatedPaths: ["CAPABILITIES.md"] });
    expect(evidence.record.decision).toMatchObject({ outcome: "allow", rule: { table: "authority", rowId: "MRG-AU-RM" } });
    expect(evidenceComment(evidence.record).split("\n")[1]).toContain("by remerge-generated-only");
  });

  it.each([
    ["a remerge that does not carry", remerged({ carries: false, generatedPaths: [] })],
    ["a remerge rule with no remerge answer", { ...remerged(), carry: { fromHead: CARRIED_FROM, head: HEAD, result: { equal: false }, rule: "remerge-generated-only" as const } }],
    ["a remerge path the answer did not match as generated", remerged({ paths: ["CAPABILITIES.md", "src/a.ts"] })],
  ])("gates on %s", async (_name, overrides) => {
    const evidence = await collect(world(), overrides);

    expect(evidence.record.decision.outcome).toBe("gate");
  });

  it("gates a remerge carry of registered kind security", async () => {
    const evidence = await collect(world(), remerged(), "security");

    expect(evidence.record.decision.outcome).toBe("gate");
  });
});

const EVIDENCE_RUN = "run-1";

/** The sh-merge-evidence route of the review wiring, run on a carried MERGE; `kind` undefined leaves the run unregistered in a bound store. */
async function carriedThroughRoute(kind: TaskKind | undefined, bind = true) {
  const store = shepherdStoreRef();
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11)]);
  if (bind) store.bind(db);
  if (kind !== undefined) new ShepherdStore(db).register({ repo: REPO, pr: 1, runId: EVIDENCE_RUN, task: "demo/1", implementer: "impl-a", policy: AUTO, kind });
  const deps: ShepherdDeps = { port: githubPort(world().wire), store, now: () => 0, sleep: async () => undefined, agentChatBin: "agent-chat" };
  const route = reviewRoutes(deps).find((candidate) => candidate.match === MERGE_EVIDENCE_STEP)!;
  const prompt = JSON.stringify({ ...input, runId: EVIDENCE_RUN, ...carried() });
  const outcome = await route.runner.run({ prompt, signal: new AbortController().signal, attempt: 0, requestKey: "k" } as unknown as RoutedStepInput);
  if (!outcome.ok) throw new Error(outcome.error);
  const { result } = JSON.parse(outcome.output) as { result: MergeEvidence };
  return result;
}

describe("the carry fact", () => {
  it.each([
    ["a probe answer for a different head", { ...carried(), carry: { fromHead: CARRIED_FROM, head: OTHER_HEAD, result: { equal: true, headTree: TREE, mergeTree: TREE } } }],
    ["a probe that said not equal even though it named equal trees", carried({ equal: false, headTree: TREE, mergeTree: TREE })],
  ])("is not recorded for %s", async (_name, overrides) => {
    const evidence = await collect(world(), overrides);

    expect(evidence.merge).not.toHaveProperty("carry");
    expect(evidence.record.decision.outcome).toBe("gate");
  });
});

describe("the evidence comment of a carried MERGE", () => {
  it("names both heads and both trees, and records the carry", async () => {
    const evidence = await collect(world(), carried());

    expect(evidence.record.carry).toEqual({ fromHead: CARRIED_FROM, head: input.head, headTree: TREE, mergeTree: TREE, rule: "tree-equal" });
  });

  it("names the head's tree and the merge-tree separately in the summary", async () => {
    const evidence = await collect(world(), carried());
    const carry = { fromHead: CARRIED_FROM, head: input.head, headTree: "tree-on-the-head-side", mergeTree: "tree-on-the-merge-side" };

    const [, summary = ""] = evidenceComment({ ...evidence.record, carry }).split("\n");

    for (const named of Object.values(carry)) expect(summary).toContain(named);
  });

  it("says nothing of a carry for a MERGE reviewed at its own head", async () => {
    const evidence = await collect(world());

    expect(evidence.record).not.toHaveProperty("carry");
    expect(evidenceComment(evidence.record)).not.toContain("Carried");
  });
});

describe("the sh-merge-evidence route reads the registered kind", () => {
  it("allows a carried MERGE of a run registered as correctness, and records that kind", async () => {
    const evidence = await carriedThroughRoute("correctness");

    expect(evidence.merge.kind).toBe("correctness");
    expect(evidence.record.decision).toMatchObject({ outcome: "allow", rule: { rowId: "MRG-AU-RC" } });
  });

  it("gates a carried MERGE of a run registered as security, and records that kind", async () => {
    const evidence = await carriedThroughRoute("security");

    expect(evidence.merge.kind).toBe("security");
    expect(evidence.record.decision.outcome).toBe("gate");
  });

  it("gates a carried MERGE when the run has no registration, and records no kind", async () => {
    const evidence = await carriedThroughRoute(undefined);

    expect(evidence.merge).not.toHaveProperty("kind");
    expect(evidence.record.decision.outcome).toBe("gate");
  });

  it("gates a carried MERGE when the store is not bound, records no kind, and names the unbound store in the reason", async () => {
    const evidence = await carriedThroughRoute("correctness", false);

    expect(evidence.merge).not.toHaveProperty("kind");
    expect(evidence.record.decision.outcome).toBe("gate");
    expect(evidence.record.decision.reason).toContain("the registered kind is unreadable: store unreadable: Error");
  });
});

describe("a fact that cannot be read", () => {
  it("gates a PR whose changed-file read fails, names the failure, and does not fail the step", async () => {
    const fake = world();
    const port = { ...githubPort(fake.wire), listPrFiles: async () => Promise.reject(Object.assign(new Error("server error at /internal"), { status: 502 })) };

    const evidence = await mergeEvidence(port, { ...input, visualPaths: ["packages/ui/**"] }, noFreezeStoreUntilTp523, { kind: "correctness" });

    expect(evidence.changedFilesUnread).toBe(`the changed files of ${REPO}#1 are unknown: the read failed: HTTP 502`);
    expect(evidence.record.decision).toMatchObject({ outcome: "gate", rule: { rowId: "files-unread" }, reason: expect.stringContaining("so the PR counts as visual") });
    expect(evidence.record.decision.reason).not.toContain("/internal");
  });

  it("names a truncated changed-file list in the gate reason", async () => {
    const fake = world();
    fake.prChangedFiles.set(1, 5);

    const evidence = await collect(fake, { visualPaths: ["packages/ui/**"] });

    expect(evidence.record.decision).toMatchObject({ outcome: "gate", rule: { rowId: "files-unread" }, reason: expect.stringContaining("the list is truncated") });
  });

  it("records the visual-path gate in the evidence comment, as decide reaches it", async () => {
    const evidence = await collect(world([{ path: "packages/ui/src/components/Button.tsx", status: "modified" }]), { visualPaths: ["packages/ui/src/components/**"] });

    expect(evidence.record.decision).toMatchObject({ outcome: "gate", rule: { rowId: "visual-path" }, reason: expect.stringContaining("packages/ui/src/components/Button.tsx") });
  });

  it("gates a blocked PR whose review ruleset read throws, and names the HTTP status in the reason", async () => {
    const fake = world();
    fake.pr(1).mergeableState = "blocked";
    const port = { ...githubPort(fake.wire), reviewRulesBypassable: async () => Promise.reject(Object.assign(new Error("server error at /internal"), { status: 500 })) };

    const evidence = await mergeEvidence(port, input, noFreezeStoreUntilTp523, { kind: "correctness" });

    const unread = `review rules of ${REPO}@${fake.pr(1).baseRef} are unreadable: HTTP 500`;
    expect(evidence.merge.mergeTreeClean).toBe(false);
    expect(evidence.unreadFacts).toEqual([unread]);
    expect(evidence.record.decision.outcome).toBe("gate");
    expect(evidence.record.decision.reason).toContain(unread);
    expect(evidence.record.decision.reason).not.toContain("/internal");
  });

  it("gates a carried MERGE whose registration read throws, and names only the store error's class, never its text", async () => {
    const leaky = new TypeError("fetch https://db.example.invalid/store failed: Authorization: Bearer tok_FAKE0000SECRET");
    const failing = { get: () => { throw leaky; } } as unknown as ShepherdStoreRef;

    const evidence = await mergeEvidence(githubPort(world().wire), { ...input, ...carried() }, noFreezeStoreUntilTp523, registeredKind(failing, "run-1"));
    const comment = evidenceComment(evidence.record);

    expect(evidence.merge).not.toHaveProperty("kind");
    expect(evidence.record.decision.outcome).toBe("gate");
    expect(evidence.unreadFacts).toEqual(["the registered kind is unreadable: store unreadable: TypeError"]);
    for (const text of [evidence.record.decision.reason, comment]) {
      expect(text).not.toContain("db.example.invalid");
      expect(text).not.toContain("tok_FAKE0000SECRET");
    }
  });

  it("names a fixed word, not the thrown value, when a registration read throws something that is not an Error", () => {
    const failing = { get: () => { throw "secret-token-value"; } } as unknown as ShepherdStoreRef;

    expect(registeredKind(failing, "run-1")).toEqual({ unread: "the registered kind is unreadable: store unreadable: non-Error" });
  });

  it("names a plain Error when a thrown error's name is not identifier-shaped", () => {
    const named = Object.assign(new Error("boom"), { name: "https://leak.example.invalid" });
    const failing = { get: () => { throw named; } } as unknown as ShepherdStoreRef;

    expect(registeredKind(failing, "run-1")).toEqual({ unread: "the registered kind is unreadable: store unreadable: Error" });
  });

  it("names a plain Error when a thrown error's identifier-shaped name looks like a GitHub token", () => {
    const named = Object.assign(new Error("boom"), { name: "ghp_FAKE0000NOTAREALTOKEN0000" });
    const failing = { get: () => { throw named; } } as unknown as ShepherdStoreRef;

    expect(registeredKind(failing, "run-1")).toEqual({ unread: "the registered kind is unreadable: store unreadable: Error" });
  });

  it("gates with the fixed class Error, never failing the step or storing the message, when a thrown error's name getter throws", async () => {
    const hostile = new Error("boom");
    Object.defineProperty(hostile, "name", { get: () => { throw new Error("getter-secret-message"); } });
    const failing = { get: () => { throw hostile; } } as unknown as ShepherdStoreRef;

    const evidence = await mergeEvidence(githubPort(world().wire), { ...input, ...carried() }, noFreezeStoreUntilTp523, registeredKind(failing, "run-1"));

    expect(evidence.unreadFacts).toEqual(["the registered kind is unreadable: store unreadable: Error"]);
    expect(evidence.record.decision.outcome).toBe("gate");
    for (const text of [evidence.record.decision.reason, evidenceComment(evidence.record)]) expect(text).not.toContain("getter-secret-message");
  });

  describe("when the thrown value is a Proxy whose type check cannot complete", () => {
    const hostileProxies: Array<[string, () => unknown]> = [
      ["a getPrototypeOf trap throws", () => new Proxy(new Error("x"), { getPrototypeOf() { throw new Error("proto-secret"); } })],
      ["it is revoked", () => { const { proxy, revoke } = Proxy.revocable(new Error("x"), {}); revoke(); return proxy; }],
    ];

    it.each(hostileProxies)("gates with the fixed class Error, never failing the step or storing text, when %s", async (_case, thrown) => {
      const failing = { get: () => { throw thrown(); } } as unknown as ShepherdStoreRef;

      const evidence = await mergeEvidence(githubPort(world().wire), { ...input, ...carried() }, noFreezeStoreUntilTp523, registeredKind(failing, "run-1"));

      expect(evidence.unreadFacts).toEqual(["the registered kind is unreadable: store unreadable: Error"]);
      expect(evidence.record.decision.outcome).toBe("gate");
      for (const text of [evidence.record.decision.reason, evidenceComment(evidence.record)]) expect(text).not.toContain("proto-secret");
    });
  });

  it("puts no non-identifier string in unreadFacts when a thrown error's name getter answers differently on each read", () => {
    const answers = ["TypeError", "https://leak/secret"];
    let reads = 0;
    const shifty = new Error("boom");
    Object.defineProperty(shifty, "name", { get: () => answers[Math.min(reads++, 1)] });
    const failing = { get: () => { throw shifty; } } as unknown as ShepherdStoreRef;

    const { unread } = registeredKind(failing, "run-1");

    expect(unread).not.toContain("leak");
    expect(unread).toMatch(/store unreadable: [A-Za-z][A-Za-z0-9_]*$/);
  });
});

describe("approve-merge under merge:auto", () => {
  it("merges with one merge-policy record naming authority/MRG-AU-RV, the evidence record, no hitl row and one comment", async () => {
    const fake = world();
    fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    const host = shepherdHost(fake);

    const run = await host.runtime.wait(host.runtime.start("shepherd-merge"));
    const record = host.runtime.status(run.id)!.stepResults["merge-policy:0:0"]!.data;

    expect(run.status).toBe("completed");
    expect(fake.effects.merge).toBe(1);
    expect(host.gates.get(gateId(run.id, "approve-merge"))).toBeUndefined();
    expect(host.pendingGates()).toEqual([]);
    expect(record).toMatchObject({
      result: { outcome: "allow", headSha: HEAD, rule: { table: "authority", rowId: "MRG-AU-RV" } },
      allowEvidence: { runId: run.id, head: HEAD, reviewer: REVIEWER, decision: { outcome: "allow" } },
    });
    expect(fake.comments.get(1)).toHaveLength(1);
  });

  it("opens approve-merge and does not merge when the facts at the head gate", async () => {
    const fake = world();
    fake.setRuns(HEAD, [successRun("validate", 1, undefined, null as unknown as string), successRun("dag-check", 2)]);
    const host = shepherdHost(fake, () => (fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)])));
    const runId = host.runtime.start("shepherd-merge");

    await gateOpened(host, gateId(runId, "approve-merge"));

    expect(fake.effects.merge).toBe(0);
    expect(host.runtime.status(runId)!.stepResults["merge-policy:0:0"]!.data).not.toHaveProperty("allowEvidence");
    host.runtime.signal(runId, "approve-merge", { decision: "abandon", headSha: HEAD }, OWNER);
    await host.runtime.wait(runId);
  });
});

describe("a 5xx while posting the sh-merge-evidence comment", () => {
  const bad502 = () => ({ error: new FakeHttpError(502, "Server Error") });

  it("retries the post and lets the run continue past the step, with one comment", async () => {
    const fake = world();
    fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    fake.createCommentFaults = [bad502()];
    const host = shepherdHost(fake);

    const run = await host.runtime.wait(host.runtime.start("shepherd-merge"));

    expect(run.status).toBe("completed");
    expect(fake.effects.merge).toBe(1);
    expect(fake.comments.get(1)).toHaveLength(1);
  });

  it("fails the run with an error naming sh-merge-evidence when every post answers 502", async () => {
    const fake = world();
    fake.createCommentFaults = Array.from({ length: 10 }, bad502);
    const host = shepherdHost(fake);

    const run = await host.runtime.wait(host.runtime.start("shepherd-merge"));

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(new RegExp(`step ${MERGE_EVIDENCE_STEP}:\\w+ \\(iteration 0\\) failed: .*502`));
    expect(fake.effects.merge).toBe(0);
  });
});

describe("an empty gh body while posting the sh-merge-evidence comment", () => {
  const emptyBody = () => ({ error: new SyntaxError("Unexpected end of JSON input") });

  it("retries the post and lets the run continue past the step, with one comment", async () => {
    const fake = world();
    fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    fake.createCommentFaults = [emptyBody()];
    const host = shepherdHost(fake);

    const run = await host.runtime.wait(host.runtime.start("shepherd-merge"));

    expect(run.status).toBe("completed");
    expect(fake.effects.merge).toBe(1);
    expect(fake.comments.get(1)).toHaveLength(1);
  });

  it("stops at the step, naming sh-merge-evidence, when every post answers an empty body", async () => {
    const fake = world();
    fake.createCommentFaults = Array.from({ length: 10 }, emptyBody);
    const host = shepherdHost(fake);

    const run = await host.runtime.wait(host.runtime.start("shepherd-merge"));

    expect(run.status).toBe("failed");
    expect(run.error).toMatch(new RegExp(`step ${MERGE_EVIDENCE_STEP}:\\w+ \\(iteration 0\\) failed: .*unexpected end of JSON input`, "i"));
    expect(fake.effects.merge).toBe(0);
  });
});
