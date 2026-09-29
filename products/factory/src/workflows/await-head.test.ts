import { fakeGitHub, fakeSha, githubPort, type FakeGitHub } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { H1, REPO } from "../test-support/land.js";
import { AWAIT_HEAD_POLL_MS, awaitNewHead, awaitNewHeadRoute } from "./await-head.js";

const H2 = fakeSha("head2");

function world(): { fake: FakeGitHub; sleeps: number[]; sleep: (ms: number) => Promise<void> } {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  const sleeps: number[] = [];
  return { fake, sleeps, sleep: async (ms) => void sleeps.push(ms) };
}

const target = { repo: REPO, pr: 1, headSha: H1 };

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
