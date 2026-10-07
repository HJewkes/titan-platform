import { FakeHttpError, fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { H1, REPO } from "../test-support/land.js";
import { AWAIT_HEAD_POLL_MS, awaitHeadOrExit, awaitNewHead, awaitNewHeadRoute } from "./await-head.js";

const H2 = fakeSha("head2");

function world(): { fake: FakeGitHub; sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  const sleeps: number[] = [];
  return { fake, sleeps, sleep: async (ms) => void sleeps.push(ms) };
}

const target = { repo: REPO, pr: 1, headSha: H1 };

describe("awaitHeadOrExit", () => {
  const woken = { ...target, agent: "impl-a" };

  it("ends with exited set once the fixer has exited and the head is still unchanged", async () => {
    const { fake, sleep } = world();
    let polls = 0;

    const { pr, exited } = await awaitHeadOrExit(githubPort(fake.wire), woken, new AbortController().signal, { sleep, agentExited: async () => ++polls >= 2 });

    expect(pr.headSha).toBe(H1);
    expect(exited).toBe(true);
  });

  it("does not report an exit when the fixer pushed a head just before it exited", async () => {
    const { fake, sleep } = world();
    const exitedAfterPush = async () => (fake.pushHead(1, H2), true);

    const { pr, exited } = await awaitHeadOrExit(githubPort(fake.wire), woken, new AbortController().signal, { sleep, agentExited: exitedAfterPush });

    expect(pr.headSha).toBe(H2);
    expect(exited).toBe(false);
  });

  it("keeps waiting while the fixer has not exited", async () => {
    const { fake, sleeps, sleep } = world();
    fake.onGetPr = (pr, reads) => void (reads === 3 && (pr.headSha = H2));

    const { exited } = await awaitHeadOrExit(githubPort(fake.wire), woken, new AbortController().signal, { sleep, agentExited: async () => false });

    expect(exited).toBe(false);
    expect(sleeps).toHaveLength(2);
  });
});

describe("awaitHeadOrExit after a red ci-wait", () => {
  const afterRed = { ...target, agent: "impl-a", untilGreen: true };
  const runsAt = (fake: FakeGitHub, validate: string) => fake.setRuns(H1, [successRun("validate", 1, undefined, validate), successRun("dag-check", 2)]);

  it("ends green at the same head once a rerun of the failed jobs passes every required check", async () => {
    const { fake, sleeps, sleep } = world();
    fake.onGetPr = (_pr, reads) => runsAt(fake, reads >= 3 ? "success" : "failure");

    const outcome = await awaitHeadOrExit(githubPort(fake.wire), afterRed, new AbortController().signal, { sleep });

    expect(outcome).toMatchObject({ pr: { headSha: H1, state: "open" }, exited: false, green: true });
    expect(sleeps).toHaveLength(2);
  });

  it("keeps waiting while a required check stays red at the same head, and ends on the new head", async () => {
    const { fake, sleeps, sleep } = world();
    fake.onGetPr = (pr, reads) => (runsAt(fake, "failure"), void (reads === 4 && (pr.headSha = H2)));

    const outcome = await awaitHeadOrExit(githubPort(fake.wire), afterRed, new AbortController().signal, { sleep });

    expect(outcome).toEqual({ pr: expect.objectContaining({ headSha: H2 }), exited: false });
    expect(sleeps).toHaveLength(3);
  });

  it("keeps waiting while a required check has not reported at the same head", async () => {
    const { fake, sleeps, sleep } = world();
    fake.onGetPr = (pr, reads) => (fake.setRuns(H1, [successRun("validate", 1)]), void (reads === 3 && (pr.headSha = H2)));

    const { pr, green } = await awaitHeadOrExit(githubPort(fake.wire), afterRed, new AbortController().signal, { sleep });

    expect(pr.headSha).toBe(H2);
    expect(green).toBeUndefined();
    expect(sleeps).toHaveLength(2);
  });

  it("ignores a green head when the wait was not after a red ci-wait", async () => {
    const { fake, sleeps, sleep } = world();
    fake.onGetPr = (pr, reads) => (runsAt(fake, "success"), void (reads === 3 && (pr.headSha = H2)));

    const { pr, green } = await awaitHeadOrExit(githubPort(fake.wire), { ...target, agent: "impl-a" }, new AbortController().signal, { sleep });

    expect(pr.headSha).toBe(H2);
    expect(green).toBeUndefined();
    expect(sleeps).toHaveLength(2);
  });

  it("as a route, records green on the unchanged head", async () => {
    const { fake, sleep } = world();
    runsAt(fake, "success");
    const route = awaitNewHeadRoute({ port: githubPort(fake.wire), sleep, now: () => 0 }, "sh-await-new-head");

    const outcome = await route.runner.run({ runId: "run-1", workflowName: "w", stepId: "sh-await-new-head:0", iteration: 0, prompt: JSON.stringify(afterRed), signal: new AbortController().signal, attempt: 0, requestKey: "k" });

    expect(outcome.ok && JSON.parse(outcome.output)).toMatchObject({ result: { headSha: H1, state: "open", green: true } });
  });
});

describe("awaitNewHead", () => {
  it("keeps polling every 30 s while the head is unchanged and returns the first read that shows a new head", async () => {
    const { fake, sleeps, sleep } = world();
    fake.onGetPr = (pr, reads) => void (reads === 4 && (pr.headSha = H2));

    const pr = await awaitNewHead(githubPort(fake.wire), target, new AbortController().signal, { sleep });

    expect(pr.headSha).toBe(H2);
    expect(sleeps).toEqual([AWAIT_HEAD_POLL_MS, AWAIT_HEAD_POLL_MS, AWAIT_HEAD_POLL_MS]);
  });

  it("returns on an unchanged head only once the pull request is no longer open", async () => {
    const { fake, sleep } = world();
    fake.onGetPr = (pr, reads) => void (reads === 2 && (pr.state = "closed"));

    const pr = await awaitNewHead(githubPort(fake.wire), target, new AbortController().signal, { sleep });

    expect(pr).toMatchObject({ headSha: H1, state: "closed" });
  });

  it("polls again after a failed read instead of failing the wait", async () => {
    const { fake, sleeps, sleep } = world();
    fake.onGetPr = (pr, reads) => {
      if (reads === 1) throw new Error("HTTP 502: bad gateway");
      pr.headSha = H2;
    };

    const pr = await awaitNewHead(githubPort(fake.wire), target, new AbortController().signal, { sleep, pollMs: 10 });

    expect(pr.headSha).toBe(H2);
    expect(sleeps).toEqual([10]);
  });

  it.each([401, 403, 404])("fails the wait at once on a %i read, naming the pull request and the status", async (status) => {
    const { fake, sleeps, sleep } = world();
    fake.onGetPr = () => {
      throw new FakeHttpError(status, "Not Found");
    };

    const wait = awaitNewHead(githubPort(fake.wire), target, new AbortController().signal, { sleep });

    await expect(wait).rejects.toThrow(`${REPO}#1: HTTP ${status}`);
    expect(sleeps).toEqual([]);
  });

  it("reports a transient read failure and keeps waiting through a 502", async () => {
    const { fake, sleep } = world();
    fake.onGetPr = (pr, reads) => {
      if (reads === 1) throw new FakeHttpError(502, "bad gateway");
      pr.headSha = H2;
    };
    const reported: string[] = [];

    const pr = await awaitNewHead(githubPort(fake.wire), target, new AbortController().signal, { sleep, onReadError: (message) => void reported.push(message) });

    expect(pr.headSha).toBe(H2);
    expect(reported).toEqual([expect.stringContaining("502")]);
  });

  it("treats a rejection that is not an Error as transient", async () => {
    const { sleeps, sleep } = world();
    const reads = [Promise.reject("socket hang up"), Promise.resolve({ headSha: H2, state: "open" })];
    const port = { getPr: () => reads.shift()! } as unknown as Parameters<typeof awaitNewHead>[0];

    const pr = await awaitNewHead(port, target, new AbortController().signal, { sleep, pollMs: 10 });

    expect(pr.headSha).toBe(H2);
    expect(sleeps).toEqual([10]);
  });

  it("stops waiting when aborted between polls", async () => {
    const { fake } = world();
    const controller = new AbortController();
    const sleep = async () => void controller.abort(new Error("host shutting down"));

    const wait = awaitNewHead(githubPort(fake.wire), target, controller.signal, { sleep });

    await expect(wait).rejects.toThrow("host shutting down");
    expect(fake.calls.filter((call) => call === "getPr")).toHaveLength(1);
  });

  it("as a route, records the new head under the caller's step family", async () => {
    const { fake, sleep } = world();
    fake.onGetPr = (pr, reads) => void (reads === 2 && (pr.headSha = H2));
    const route = awaitNewHeadRoute({ port: githubPort(fake.wire), sleep, now: () => 0 }, "sh-await-new-head");

    const outcome = await route.runner.run({ runId: "run-1", workflowName: "w", stepId: "sh-await-new-head:0", iteration: 0, prompt: JSON.stringify(target), signal: new AbortController().signal, attempt: 0, requestKey: "k" });

    expect(route).toMatchObject({ match: "sh-await-new-head", onRestart: "repeat" });
    expect(outcome.ok && JSON.parse(outcome.output)).toMatchObject({ result: { headSha: H2, state: "open", merged: false } });
  });
});
