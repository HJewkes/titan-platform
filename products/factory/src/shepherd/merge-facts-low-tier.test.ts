import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type PrFile } from "@titan-design/github";
import type { ReviewerAgent } from "@titan-design/review-panel";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { fakeLocator } from "../test-support/fakes.js";
import { attestAtHead, type AttestReaders } from "./attest-evidence.js";
import { attestationsFileOf } from "./attest-read.js";
import { mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./merge-facts.js";
import type { Registration, ShepherdStore, ShepherdStoreRef } from "./store.js";

const REPO = "octo/demo";
const HEAD = fakeSha("low-tier-evidence-head");
const HOLD_CLOSURE_PATH = "products/factory/src/shepherd/wake-loop.ts";
const CI_WAIT = { step: "ci-wait", closure: fakeSha("closure-ci-wait") + fakeSha("closure-ci-wait-tail").slice(0, 24), pr: 1 };
const ATTESTS = [`${CI_WAIT.step}@${CI_WAIT.closure.slice(0, 12)}`];

const agent = (name: string): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence: "live", spawnedBy: "human", predecessor: null });
const identity = (name: string) => ({ agentId: `agent-${name}`, sessionId: `session-${name}` });

/** PR 1 at HEAD changing `paths` and claiming the ci-wait row. */
function world(paths: string[]): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("low-tier-evidence-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1)]);
  const files: PrFile[] = [...paths.map((path): PrFile => ({ path, status: "modified", additions: 10, deletions: 0 })), { path: attestationsFileOf(1), status: "added", additions: 1, deletions: 0 }];
  fake.prFiles.set(1, files);
  const content = JSON.stringify([CI_WAIT]);
  fake.files.set(`${HEAD}:${attestationsFileOf(1)}`, { content, blobSha: fakeSha(content) });
  return fake;
}

function readers(holdReason: string): AttestReaders {
  const registration = partialFake<Registration>({ runId: "run-1", implementer: "impl-a", holdReason });
  const store = partialFake<ShepherdStore>({ byRun: () => registration, authorsOf: () => [] });
  return { store: partialFake<ShepherdStoreRef>({ get: () => store }), roster: async () => [agent("impl-a"), agent("rev-1")] };
}

const input: MergeEvidenceInput = {
  ...{ runId: "run-1", repo: REPO, pr: 1, head: HEAD, seatGrants: ["merge-on-green-approve"], attest: { attests: ATTESTS } },
  verdict: { value: "MERGE", head: HEAD, locator: fakeLocator({ sourceId: "transcript-1", selector: { kind: "subrecord-text" } }) },
  ...{ resolver: identity("rev-1"), dispatchedReviewer: identity("rev-1") },
};

async function evidence(paths: string[], holdReason: string) {
  const port = githubPort(world(paths).wire);
  return mergeEvidence(port, input, noFreezeStoreUntilTp523, { kind: "feature" }, undefined, { attest: (i, baseRef) => attestAtHead(port, readers(holdReason), i, baseRef) });
}

describe("the merge evidence of a low-tier policy touch", () => {
  it("the record carries the low-tier decision beside the risk tier", async () => {
    const { record } = await evidence([HOLD_CLOSURE_PATH], "g10-review: low-tier policy touch (hold-closure)");

    expect(record).toMatchObject({ riskTier: { tier: "medium", reasons: ["medium: policy touch"] }, lowTier: { eligible: true, tables: ["hold-closure"] } });
  });

  it("a PR with no policy path records no low-tier decision", async () => {
    const { record } = await evidence(["packages/x/src/a.ts"], "g10-review: low-tier policy touch (hold-closure)");

    expect(record.lowTier).toBeUndefined();
  });

  it("a low-tier run's claimed row is met by the correctness MERGE alone", async () => {
    const { record } = await evidence([HOLD_CLOSURE_PATH], "g10-review: low-tier policy touch (hold-closure)");

    expect({ attested: record.attested?.map(({ step }) => step), unmet: record.attestUnmet }).toEqual({ attested: ["ci-wait"], unmet: [] });
  });

  it("the same claim under an adversary hold still wants the adversary", async () => {
    const { record } = await evidence([HOLD_CLOSURE_PATH], "g10-adversary: policy touch (kept: gate-resolve-actor)");

    expect(record.attestUnmet).toEqual([{ step: "ci-wait", why: "adversary-missing" }]);
  });
});
