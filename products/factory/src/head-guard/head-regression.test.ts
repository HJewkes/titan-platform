import { fakeGitHub, fakeSha, githubPort, successRun, type GitHubPort, type PullRequest } from "@titan-design/github";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { REPO } from "../test-support/land.js";
import { movedHead } from "../shepherd/head-moved.js";
import type { Registration, ShepherdStoreRef } from "../shepherd/store.js";
import { headPoll } from "../shepherd/push-signal.js";
import { readCi } from "../workflows/land-ci.js";
import type { Ancestry, Unavailable } from "./classify.js";
import { headRegressionObserver, logIfBehind } from "./head-regression.js";

const HELD = fakeSha("held");
const READ = fakeSha("read");

type Answer = Ancestry | Unavailable | "throws";
const source = (answer: Answer) => ({
  compareAncestry: async () => {
    if (answer === "throws") throw new Error("compare failed");
    return answer;
  },
});
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("logIfBehind", () => {
  it("logs one head-regression line when the read is behind the held head", async () => {
    const lines: string[] = [];

    await logIfBehind(source("behind"), (line) => lines.push(line), { repo: "o/r", pr: 7, held: HELD, read: READ });

    expect(lines).toEqual([`head-regression repo=o/r pr=7 held=${HELD} read=${READ}`]);
  });

  it.each<Answer>(["ahead", "diverged", "identical", "missing", { kind: "unavailable" }, "throws"])("logs nothing for an ancestry answer of %j", async (answer) => {
    const lines: string[] = [];

    await logIfBehind(source(answer), (line) => lines.push(line), { repo: "o/r", pr: 7, held: HELD, read: READ });

    expect(lines).toEqual([]);
  });

  it("asks nothing when the read equals the held head", async () => {
    const asked: string[] = [];
    const port = { compareAncestry: async (...args: string[]) => (asked.push(args.join()), "behind" as const) };

    await logIfBehind(port, () => asked.push("logged"), { repo: "o/r", pr: 7, held: HELD, read: HELD });

    expect(asked).toEqual([]);
  });
});

function pr(headSha: string, state: PullRequest["state"] = "open"): PullRequest {
  const fake = fakeGitHub();
  return { ...fake.addPr({ headSha }), state };
}

describe("headPoll at a head that left the held one", () => {
  it("logs a behind read once and still returns the PR it read", async () => {
    const lines: string[] = [];
    const read = pr(READ);
    const poll = headPoll({ repo: REPO, headSha: HELD, read: async () => read, observe: headRegressionObserver(source("behind"), (line) => lines.push(line)) });

    const polled = await poll.next();
    await settled();

    expect(polled).toEqual({ read: true, pr: read });
    expect(lines).toHaveLength(1);
  });

  it("logs nothing for an ahead read, a read of the held head, or a failed ancestry read", async () => {
    const lines: string[] = [];
    for (const answer of ["ahead", "diverged", "throws"] as const) {
      await headPoll({ repo: REPO, headSha: HELD, read: async () => pr(READ), observe: headRegressionObserver(source(answer), (line) => lines.push(line)) }).next();
    }
    await headPoll({ repo: REPO, headSha: HELD, read: async () => pr(HELD), observe: headRegressionObserver(source("behind"), (line) => lines.push(line)) }).next();
    await settled();

    expect(lines).toEqual([]);
  });
});

describe("movedHead", () => {
  function scenario(answer: Ancestry | "throws", lines: string[]) {
    const fake = fakeGitHub();
    const open = fake.addPr({ headSha: READ, mergeableState: "clean" });
    const port = partialFake<GitHubPort>({ getPr: githubPort(fake.wire).getPr, compareAncestry: async () => (answer === "throws" ? Promise.reject(new Error("compare failed")) : answer) });
    const registration = { repo: REPO, pr: open.number };
    return partialFake<Parameters<typeof movedHead>[0]>({ store: partialFake<ShepherdStoreRef>({ get: () => partialFake<ReturnType<ShepherdStoreRef["get"]>>({ byRun: () => partialFake<Registration>(registration) }) }), port, headLog: (line) => lines.push(line) });
  }

  it("returns the moved head and logs once when that head is behind the asked one", async () => {
    const lines: string[] = [];

    expect(await movedHead(scenario("behind", lines), "run", HELD)).toBe(READ);
    await settled();

    expect(lines).toHaveLength(1);
  });

  it("returns the same head and logs nothing on an ahead read or a failed ancestry read", async () => {
    const lines: string[] = [];

    expect(await movedHead(scenario("ahead", lines), "run", HELD)).toBe(READ);
    expect(await movedHead(scenario("throws", lines), "run", HELD)).toBe(READ);
    await settled();

    expect(lines).toEqual([]);
  });
});

describe("readCi against a held head", () => {
  async function read(answer: Answer, lines: string[]) {
    const fake = fakeGitHub();
    fake.addPr({ headSha: READ, mergeableState: "clean" });
    fake.setRuns(READ, [successRun("validate", 1)]);
    const observeHead = headRegressionObserver(source(answer), (line) => lines.push(line));
    return readCi(githubPort(fake.wire), { repo: REPO, pr: 1, contexts: ["validate"], strict: false }, undefined, { heldHead: HELD, observeHead });
  }

  it("logs once for a behind read and returns the snapshot it would have without the observer", async () => {
    const lines: string[] = [];
    const fake = fakeGitHub();
    fake.addPr({ headSha: READ, mergeableState: "clean" });
    fake.setRuns(READ, [successRun("validate", 1)]);
    const bare = await readCi(githubPort(fake.wire), { repo: REPO, pr: 1, contexts: ["validate"], strict: false });

    const observed = await read("behind", lines);
    await settled();

    expect(observed).toEqual(bare);
    expect(lines).toHaveLength(1);
  });

  it("logs nothing for an ahead read or a failed ancestry read", async () => {
    const lines: string[] = [];

    await read("diverged", lines);
    await read("throws", lines);
    await settled();

    expect(lines).toEqual([]);
  });
});
