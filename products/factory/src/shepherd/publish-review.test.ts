import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { REPO, gateId, gateOpened } from "../test-support/land.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { REVIEW_CHECK_NAME } from "./publish-review.js";
import { reviewPhase, type AwaitVerdictInput, type ReviewerAgent, type ReviewerDispatch, type ReviewerReader } from "./review.js";
import { shepherdStoreRef } from "./store.js";

const A = fakeSha("publish-review-a");
const B = fakeSha("publish-review-b");

/** The real review phase; every wake is unhandled, so no test reaches an agent-chat binary. */
const PHASES: ShepherdPhases = { review: reviewPhase, wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }) };

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const locatorIn = (nativeId: string) =>
  ({ source: { conversation: { nativeId } }, selector: { kind: "subrecord-text", path: ["message", "content", 0, "text"] } }) as unknown as SourceTextLocator;

/** Every spawned reviewer is live at once with a started session. */
function liveDispatch(): ReviewerDispatch {
  const agents: ReviewerAgent[] = [];
  return {
    roster: async () => [...agents],
    spawn: async (name) => void agents.push({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence: "live", spawnedBy: null, predecessor: null }),
    resume: async () => undefined,
  };
}

/** The reviewer says `verdict` about the head it was asked; `afterRead` runs once that verdict has been read. */
function verdictReader(clock: () => number, verdict: (head: string) => string, afterRead: (head: string) => void = () => undefined): ReviewerReader {
  return {
    read: async (input: AwaitVerdictInput) => {
      afterRead(input.head);
      const text = `Read it.\n\nVerdict: ${verdict(input.head)}\nPR: ${REPO}#1\nHead: ${input.head}\n`;
      return [{ agentId: input.reviewerAgentId, sessionId: input.reviewerSessionId, writtenAt: clock() + 1, text, locator: locatorIn(input.reviewerSessionId) }];
    },
  };
}

interface Scene {
  fake: FakeGitHub;
  reader: (clock: () => number) => ReviewerReader;
  reviewCheck?: GitHubPort;
  /** The gate the run waits on; defaults to approve-merge. */
  gate?: string;
}

/** One owner-gated shepherd-pr run with the real review phase, waiting on its first `gate`. */
async function gatedRun({ fake, reader, reviewCheck, gate = "approve-merge" }: Scene): Promise<{ host: FactoryHost; runId: string }> {
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  let clock = 10_000;
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({
    port: githubPort(fake.wire),
    store,
    now: () => clock,
    sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)),
    review: { reader: reader(() => clock), dispatch: liveDispatch(), timeoutMs: 5_000 },
    ...(reviewCheck && { reviewCheck }),
  });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(PHASES)], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: A, mergeSha: fakeSha("publish-review-merge") });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  await gateOpened(host, gateId(runId, gate));
  return { host, runId };
}

const posted = (fake: FakeGitHub) => fake.createdCheckRuns.map(({ request }) => ({ name: request.name, headSha: request.headSha, conclusion: request.conclusion }));

function publishResults(host: FactoryHost, runId: string): Record<string, unknown>[] {
  const results = Object.values(host.runtime.status(runId)!.stepResults).filter((result) => result.stepId.startsWith("sh-publish-review:"));
  return results.map((result) => (result.data as { result: Record<string, unknown> }).result);
}

describe("sh-publish-review", () => {
  it("a moved head turns the check action_required: MERGE at A posts success at A, then the moved head posts action_required at B", async () => {
    const fake = fakeGitHub();
    let moved = false;
    const moveOnce = (head: string) => void (head === A && !moved && ((moved = true), fake.pushHead(1, B)));

    await gatedRun({ fake, reader: (clock) => verdictReader(clock, () => "MERGE", moveOnce), reviewCheck: githubPort(fake.wire) });

    expect(posted(fake).slice(0, 2)).toEqual([
      { name: REVIEW_CHECK_NAME, headSha: A, conclusion: "success" },
      { name: REVIEW_CHECK_NAME, headSha: B, conclusion: "action_required" },
    ]);
    expect(fake.createdCheckRuns[1]!.request.title).toContain(A.slice(0, 12));
  });

  it("posts a FIX_FIRST as failure at the reviewed head", async () => {
    const fake = fakeGitHub();

    await gatedRun({ fake, reader: (clock) => verdictReader(clock, () => "FIX_FIRST"), reviewCheck: githubPort(fake.wire), gate: "sh-sent-back" });

    expect(posted(fake)).toEqual([{ name: REVIEW_CHECK_NAME, headSha: A, conclusion: "failure" }]);
  });

  it("an unconfigured App publishes nothing, records published false with the check URL absent, and the run continues to the gate", async () => {
    const fake = fakeGitHub();

    const { host, runId } = await gatedRun({ fake, reader: (clock) => verdictReader(clock, () => "MERGE") });

    expect(fake.createdCheckRuns).toEqual([]);
    expect(publishResults(host, runId)).toEqual([{ headSha: A, conclusion: "success", published: false, reason: "no shepherd.reviewCheck App is configured" }]);
  });

  it("records a failed post without failing the run, and carries checkRunUrl only when published", async () => {
    const fake = fakeGitHub();
    const failing: GitHubPort = { ...githubPort(fake.wire), createCheckRun: async () => Promise.reject(Object.assign(new Error("Bad credentials"), { status: 401 })) };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const { host, runId } = await gatedRun({ fake, reader: (clock) => verdictReader(clock, () => "MERGE"), reviewCheck: failing });

    expect(publishResults(host, runId)).toEqual([{ headSha: A, conclusion: "success", published: false, reason: "the check run post failed: HTTP 401" }]);
  });

  it("carries the check run URL in the step output when published", async () => {
    const fake = fakeGitHub();

    const { host, runId } = await gatedRun({ fake, reader: (clock) => verdictReader(clock, () => "MERGE"), reviewCheck: githubPort(fake.wire) });

    const [id] = fake.createdCheckRuns.map((run) => run.id);
    expect(publishResults(host, runId)).toEqual([{ headSha: A, conclusion: "success", published: true, checkRunId: id, checkRunUrl: `https://github.com/${REPO}/runs/${id}` }]);
  });
});
