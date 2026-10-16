import { FakeHttpError, fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { AWAIT_HEAD_BACKSTOP_MS, PUSH_WATCH_TICK_MS, pushSignal } from "../shepherd/push-signal.js";
import { H1, REPO } from "../test-support/land.js";
import { fixtureClone } from "../test-support/reflog.js";
import { BASE_RED_RECHECK_MS, CHECKS_RECHECK_MS, awaitHeadOrExit, awaitNewHead, awaitNewHeadRoute } from "./await-head.js";
import { prSnapshot } from "./pr-snapshot.js";

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

describe("awaitHeadOrExit after a ci-red whose failing checks may be the base's", () => {
  const afterCiRed = { ...target, failing: ["validate"] };
  const hook = (answer: () => Promise<boolean>) => {
    let calls = 0;
    return { calls: () => calls, inheritedRed: () => () => (calls++, answer()) };
  };

  it("ends baseRed at the unchanged head once the checker judges the red the base's", async () => {
    const { fake, sleeps, sleep } = world();
    let asked = 0;
    const checker = hook(async () => ++asked >= 2);

    const outcome = await awaitHeadOrExit(githubPort(fake.wire), afterCiRed, new AbortController().signal, { sleep, inheritedRed: checker.inheritedRed });

    expect(outcome).toEqual({ pr: expect.objectContaining({ headSha: H1, state: "open" }), exited: false, baseRed: true });
    expect(sleeps).toHaveLength(1);
  });

  it("never asks the checker when the wait carries no failing checks, and ends only on a new head", async () => {
    const { fake, sleep } = world();
    fake.onGetPr = (pr, reads) => void (reads === 3 && (pr.headSha = H2));
    const checker = hook(async () => true);

    const outcome = await awaitHeadOrExit(githubPort(fake.wire), target, new AbortController().signal, { sleep, inheritedRed: checker.inheritedRed });

    expect(outcome).toEqual({ pr: expect.objectContaining({ headSha: H2 }), exited: false });
    expect(checker.calls()).toBe(0);
  });

  it("reports a checker that throws and keeps waiting for a new head", async () => {
    const { fake, sleep } = world();
    fake.onGetPr = (pr, reads) => void (reads === 3 && (pr.headSha = H2));
    const reported: string[] = [];
    const checker = hook(async () => {
      throw new Error("HTTP 502: bad gateway");
    });

    const outcome = await awaitHeadOrExit(githubPort(fake.wire), afterCiRed, new AbortController().signal, { sleep, inheritedRed: checker.inheritedRed, onReadError: (message) => void reported.push(message) });

    expect(outcome).toEqual({ pr: expect.objectContaining({ headSha: H2 }), exited: false });
    expect(reported).toEqual([expect.stringContaining("502"), expect.stringContaining("502")]);
  });

  it("as a route, records baseRed on the unchanged head", async () => {
    const { fake, sleep } = world();
    const route = awaitNewHeadRoute({ port: githubPort(fake.wire), sleep, now: () => 0, inheritedRed: hook(async () => true).inheritedRed });

    const outcome = await route.runner.run({ runId: "run-1", workflowName: "w", stepId: "await-new-head:0", iteration: 0, prompt: JSON.stringify(afterCiRed), signal: new AbortController().signal, attempt: 0, requestKey: "k" });

    expect(outcome.ok && JSON.parse(outcome.output)).toMatchObject({ result: { headSha: H1, state: "open", baseRed: true } });
  });
});

describe("awaitNewHead", () => {
  it("with no reflog watched, reads once per backstop and returns the first read that shows a new head", async () => {
    const { fake, sleeps, sleep } = world();
    fake.onGetPr = (pr, reads) => void (reads === 4 && (pr.headSha = H2));

    const pr = await awaitNewHead(githubPort(fake.wire), target, new AbortController().signal, { sleep });

    expect(pr.headSha).toBe(H2);
    expect(sleeps).toEqual([AWAIT_HEAD_BACKSTOP_MS, AWAIT_HEAD_BACKSTOP_MS, AWAIT_HEAD_BACKSTOP_MS]);
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

    const pr = await awaitNewHead(githubPort(fake.wire), target, new AbortController().signal, { sleep });

    expect(pr.headSha).toBe(H2);
    expect(sleeps).toEqual([AWAIT_HEAD_BACKSTOP_MS]);
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

    const pr = await awaitNewHead(port, target, new AbortController().signal, { sleep });

    expect(pr.headSha).toBe(H2);
    expect(sleeps).toEqual([AWAIT_HEAD_BACKSTOP_MS]);
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

describe("awaitNewHead on the push reflog", () => {
  const BRANCH = "agent-chat/tc-demo-a";
  const H0 = fakeSha("head0");

  /** A PR on `branch` at H1, its clone's reflog ending on H1, and a sleep that runs `onSleep` with the total slept so far. */
  function pushWorld(branch = BRANCH) {
    const fake = fakeGitHub();
    fake.addPr({ headSha: H1, headRef: branch });
    const { clone, push } = fixtureClone();
    push(branch, H0, H1);
    const controller = new AbortController();
    const sleeps: number[] = [];
    let onSleep: (slept: number) => void = () => undefined;
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
      onSleep(sleeps.reduce((sum, each) => sum + each, 0));
    };
    const getPrs = () => fake.calls.filter((call) => call === "getPr").length;
    const timing = { sleep, pushes: pushSignal(() => clone) };
    return { fake, push, controller, sleeps, getPrs, timing, after: (hook: (slept: number) => void) => void (onSleep = hook) };
  }

  it("ends within one watch tick of a reflog append, with one getPr after it", async () => {
    const world = pushWorld();
    let atPush = 0;
    world.after((slept) => {
      if (slept !== 2 * PUSH_WATCH_TICK_MS) return;
      atPush = world.getPrs();
      world.push(BRANCH, H1, H2);
      world.fake.pushHead(1, H2);
    });

    const pr = await awaitNewHead(githubPort(world.fake.wire), target, world.controller.signal, world.timing);

    expect(pr.headSha).toBe(H2);
    expect(world.sleeps).toEqual([PUSH_WATCH_TICK_MS, PUSH_WATCH_TICK_MS]);
    expect(world.getPrs() - atPush).toBe(1);
  });

  it("confirms a reflog append through the snapshot after dropping its stale row", async () => {
    const world = pushWorld();
    const port = githubPort(world.fake.wire);
    const snapshot = prSnapshot(port, { now: () => 0 });
    await snapshot.getPr(REPO, 1);
    world.after(() => (world.push(BRANCH, H1, H2), world.fake.pushHead(1, H2)));

    const pr = await awaitNewHead(port, target, world.controller.signal, { ...world.timing, snapshot });

    expect(pr.headSha).toBe(H2);
    expect(world.sleeps).toHaveLength(1);
  });

  it("with no reflog append, reads the PR once per five minutes", async () => {
    const world = pushWorld();
    world.after((slept) => void (slept > 15 * 60_000 && world.controller.abort(new Error("test over"))));

    await expect(awaitNewHead(githubPort(world.fake.wire), target, world.controller.signal, world.timing)).rejects.toThrow("test over");

    expect(world.getPrs()).toBe(4);
  });

  it("ends through the backstop on a branch with no reflog, as after a push from outside the clone", async () => {
    const world = pushWorld("feature/demo");
    world.after((slept) => void (slept === PUSH_WATCH_TICK_MS && world.fake.pushHead(1, H2)));

    const pr = await awaitNewHead(githubPort(world.fake.wire), target, world.controller.signal, world.timing);

    expect(pr.headSha).toBe(H2);
    expect(world.sleeps.reduce((sum, each) => sum + each, 0)).toBe(AWAIT_HEAD_BACKSTOP_MS);
    expect(world.getPrs()).toBe(2);
  });

  it("ignores a reflog append for another branch", async () => {
    const world = pushWorld();
    world.after((slept) => {
      if (slept === PUSH_WATCH_TICK_MS) world.push("agent-chat/tc-demo-b", H0, H2);
      if (slept >= 4 * PUSH_WATCH_TICK_MS) world.controller.abort(new Error("test over"));
    });

    await expect(awaitNewHead(githubPort(world.fake.wire), target, world.controller.signal, world.timing)).rejects.toThrow("test over");

    expect(world.getPrs()).toBe(1);
  });

  it("confirms at once a push the reflog shows that the first read missed", async () => {
    const world = pushWorld();
    world.push(BRANCH, H1, H2);
    world.fake.onGetPr = (pr, reads) => void (reads === 2 && (pr.headSha = H2));

    const pr = await awaitNewHead(githubPort(world.fake.wire), target, world.controller.signal, world.timing);

    expect(pr.headSha).toBe(H2);
    expect(world.sleeps).toEqual([PUSH_WATCH_TICK_MS]);
  });

  it("after a red ci-wait, reads the unchanged head's checks once per pending cadence, not per tick", async () => {
    const world = pushWorld();
    world.fake.setRuns(H1, [successRun("validate", 1, undefined, "failure")]);
    world.after((slept) => void (slept >= 3 * CHECKS_RECHECK_MS && world.controller.abort(new Error("test over"))));

    const wait = awaitHeadOrExit(githubPort(world.fake.wire), { ...target, untilGreen: true }, world.controller.signal, world.timing);

    await expect(wait).rejects.toThrow("test over");
    expect(world.fake.calls.filter((call) => call === "listCheckRuns")).toHaveLength(3);
  });

  it("after a ci-red, asks the base-red checker once per its cadence, not per tick", async () => {
    const world = pushWorld();
    world.after((slept) => void (slept >= 3 * BASE_RED_RECHECK_MS && world.controller.abort(new Error("test over"))));
    let calls = 0;
    const inheritedRed = () => async () => (calls++, false);

    const wait = awaitHeadOrExit(githubPort(world.fake.wire), { ...target, failing: ["validate"] }, world.controller.signal, { ...world.timing, inheritedRed });

    await expect(wait).rejects.toThrow("test over");
    expect(calls).toBe(3);
  });
});
