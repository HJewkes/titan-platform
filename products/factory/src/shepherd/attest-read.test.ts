import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { ReviewerAgent } from "@titan-design/review-panel";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { fakeLocator } from "../test-support/fakes.js";
import { attestAtHead, type AttestReaders } from "./attest-evidence.js";
import { ATTESTATIONS_PATH, briefClaimsAt, readClaims } from "./attest-read.js";
import { mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./merge-facts.js";
import type { Registration, ShepherdStore, ShepherdStoreRef } from "./store.js";

const REPO = "octo/demo";
const HEAD = fakeSha("attest-read-head");
const closure = (seed: string) => fakeSha(`closure-${seed}`) + fakeSha(`closure-${seed}-tail`).slice(0, 24);
const CI_WAIT = { step: "ci-wait", closure: closure("ci-wait"), pr: 1 };
const MERGE_STEP = { step: "merge", closure: closure("merge"), pr: 1 };

const agent = (name: string, spawnedBy: string | null): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence: "live", spawnedBy, predecessor: null });
const roster = [agent("human", null), agent("impl-a", "human"), agent("rev-1", "human"), agent("adv-1", "human")];
const identity = (name: string) => ({ agentId: `agent-${name}`, sessionId: `session-${name}` });

function world(base: unknown, head: unknown): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("attest-test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1)]);
  fake.prFiles.set(1, [{ path: ATTESTATIONS_PATH, status: "modified" }]);
  if (base !== undefined) fake.files.set(`main:${ATTESTATIONS_PATH}`, { content: JSON.stringify(base), blobSha: "b-base" });
  fake.files.set(`${HEAD}:${ATTESTATIONS_PATH}`, { content: typeof head === "string" ? head : JSON.stringify(head), blobSha: "b-head" });
  return fake;
}

function readers(holdReason: string | null = null): AttestReaders {
  const registration = partialFake<Registration>({ runId: "run-1", implementer: "impl-a", holdReason });
  const store = partialFake<ShepherdStore>({ byRun: () => registration, authorsOf: () => [] });
  return { store: partialFake<ShepherdStoreRef>({ get: () => store }), roster: async () => roster };
}

const input = (reviewer: string, attests: string[]): MergeEvidenceInput => ({
  runId: "run-1",
  repo: REPO,
  pr: 1,
  head: HEAD,
  verdict: { value: "MERGE", head: HEAD, locator: fakeLocator({ sourceId: "transcript-1", selector: { kind: "subrecord-text" } }) },
  resolver: identity(reviewer),
  dispatchedReviewer: identity(reviewer),
  seatGrants: ["merge-on-green-approve"],
  attest: { attests },
});

const token = (row: { step: string; closure: string }) => `${row.step}@${row.closure.slice(0, 12)}`;

async function evidence(fake: FakeGitHub, request: MergeEvidenceInput, holdReason?: string) {
  const port = githubPort(fake.wire);
  return mergeEvidence(port, request, noFreezeStoreUntilTp523, { kind: "correctness" }, undefined, { attest: (i, baseRef) => attestAtHead(port, readers(holdReason), i, baseRef) });
}

describe("readClaims", () => {
  it("rows are read at the base ref and the head, and only new or changed rows are claimed", async () => {
    const changed = { ...MERGE_STEP, closure: closure("merge-changed") };
    const fake = world([CI_WAIT, MERGE_STEP], [CI_WAIT, changed, { step: "land", closure: closure("land"), pr: 1 }]);

    const read = await readClaims(githubPort(fake.wire), { repo: REPO, base: "main", head: HEAD });

    expect(read).toEqual({ claimed: [changed, { step: "land", closure: closure("land"), pr: 1 }] });
  });

  it("a malformed head file reads unread, never as claiming nothing", async () => {
    const read = await readClaims(githubPort(world(undefined, "[{").wire), { repo: REPO, base: "main", head: HEAD });

    expect(read).toEqual({ unread: `${ATTESTATIONS_PATH} is unreadable: malformed` });
  });
});

describe("briefClaimsAt", () => {
  it("asks the reviewer about each row the head claims against the PR's base", async () => {
    const claims = await briefClaimsAt(githubPort(world([CI_WAIT], [CI_WAIT, MERGE_STEP]).wire), { repo: REPO, pr: 1, head: HEAD });

    expect(claims).toEqual({ attestClaims: [{ step: "merge", closure: MERGE_STEP.closure }] });
  });
});

describe("the evidence record's attestations", () => {
  it("names the independent reviewer that met a row and why the row it left out is unmet", async () => {
    const result = await evidence(world([], [CI_WAIT, MERGE_STEP]), input("rev-1", [token(CI_WAIT)]));

    expect(result.record.attested).toEqual([{ step: "ci-wait", closure: CI_WAIT.closure, meeters: [{ name: "rev-1", agentId: "agent-rev-1", shape: "correctness" }] }]);
    expect(result.record.attestUnmet).toEqual([{ step: "merge", why: "no-meeter" }]);
  });

  it("records the implementer's own Attests line as unmet: meeter-is-author", async () => {
    const result = await evidence(world([], [CI_WAIT]), input("impl-a", [token(CI_WAIT)]));

    expect(result.record).toMatchObject({ attested: [], attestUnmet: [{ step: "ci-wait", why: "meeter-is-author" }] });
  });

  it("on a g10-adversary hold the correctness line alone is unmet: adversary-missing", async () => {
    const result = await evidence(world([], [CI_WAIT]), input("rev-1", [token(CI_WAIT)]), "g10-adversary: authority path");

    expect(result.record.attestUnmet).toEqual([{ step: "ci-wait", why: "adversary-missing" }]);
  });
});
