import { FakeHttpError, fakeGitHub, fakeSha, githubPort, type FakeGitHub } from "@titan-design/github";
import type { StepResult } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { BRANCH, callCommand, shepherdFixture } from "../test-support/shepherd.js";
import type { Registered, StatusRow } from "./commands.js";
import { cascadeStack, type CascadeInput, type ChildWake } from "./stack-cascade.js";

const PARENT_BRANCH = "agent-chat/parent";
const OLD_HEAD = fakeSha("parent-old");
const NEW_HEAD = fakeSha("parent-new");

interface Stack {
  fake: FakeGitHub;
  parent: number;
  children: number[];
  wakes: ChildWake[];
  run: (input?: Partial<CascadeInput>) => ReturnType<typeof cascadeStack>;
}

function stack(childCount: number): Stack {
  const fake = fakeGitHub({ repo: REPO });
  const parent = fake.addPr({ headSha: NEW_HEAD, headRef: PARENT_BRANCH }).number;
  const children = Array.from({ length: childCount }, (_, i) => fake.addPr({ headSha: fakeSha(`child-${i}`), headRef: `agent-chat/child-${i}`, baseRef: PARENT_BRANCH, behind: true }).number);
  fake.addPr({ headSha: fakeSha("unrelated"), headRef: "agent-chat/unrelated" });
  const wakes: ChildWake[] = [];
  const deps = { port: githubPort(fake.wire), wakeChild: async (wake: ChildWake) => void wakes.push(wake) };
  const base: CascadeInput = { repo: REPO, parentPr: parent, parentHeadRef: PARENT_BRANCH, previousHead: OLD_HEAD, newHead: NEW_HEAD };
  return { fake, parent, children, wakes, run: (input = {}) => cascadeStack(deps, { ...base, ...input }) };
}

describe("cascadeStack", () => {
  it("a parent's new head makes one update-branch per stacked child and wakes no agent", async () => {
    const s = stack(2);
    const before = s.children.map((pr) => s.fake.pr(pr).headSha);

    const results = await s.run();

    expect(results).toEqual(s.children.map((pr) => ({ pr, outcome: "updated" })));
    expect(s.fake.effects.updateBranch).toBe(2);
    expect(s.wakes).toEqual([]);
    s.children.forEach((pr, i) => expect(s.fake.commits.get(s.fake.pr(pr).headSha)?.parents[0]).toBe(before[i]));
  });

  it("a child whose base will not merge in wakes its implementer and leaves the other child updated", async () => {
    const s = stack(2);
    const [conflicted, clean] = s.children as [number, number];
    const conflictedHead = s.fake.pr(conflicted).headSha;
    s.fake.updateBranchFaults = [{ error: new FakeHttpError(422, "merge conflict between base and head") }];

    const results = await s.run();

    expect(results).toEqual([
      { pr: conflicted, outcome: "conflict", reason: `parent #${s.parent} moved; merge conflict` },
      { pr: clean, outcome: "updated" },
    ]);
    expect(s.wakes).toEqual([{ repo: REPO, pr: conflicted, headSha: conflictedHead, reason: `parent #${s.parent} moved; merge conflict` }]);
    expect(s.fake.pr(conflicted).headSha).toBe(conflictedHead);
  });

  it("a parent with no stacked children updates nothing", async () => {
    const s = stack(0);

    expect(await s.run()).toEqual([]);
    expect(s.fake.calls).not.toContain("updateBranch");
  });

  it("a head equal to the last one seen cascades nothing", async () => {
    const s = stack(2);

    expect(await s.run({ previousHead: NEW_HEAD })).toEqual([]);
    expect(s.fake.calls).not.toContain("updateBranch");
    expect(s.fake.calls).not.toContain("listOpenPrs");
  });
});

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

function newHeadAt(round: number): StepResult {
  return { stepId: "sh-await-new-head", iteration: round, operation: "dispatch", agentId: null, signal: null, completedAt: "2026-10-05T00:00:00Z", data: { result: { headSha: fakeSha(`fix-${round}`), state: "open" } } };
}

const EXITED: StepResult = { ...newHeadAt(9), data: { result: { headSha: H1, state: "open", exited: true } } };

/** The registered parent's run reads as if it had taken `rounds` fix rounds that each pushed a new head, plus one fixer exit with no push. */
async function statusAfter(rounds: number): Promise<StatusRow> {
  const fixture = shepherdFixture({ frozen: true });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
  const registered = await callCommand<Registered>(host, fixture.routes, "shepherd.register", { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a" });
  if (!registered.ok) throw new Error(registered.error);
  const steps = Object.fromEntries([...Array.from({ length: rounds }, (_, round) => newHeadAt(round)), EXITED].map((result) => [`${result.stepId}:${result.iteration}`, result]));
  const status = host.runtime.status.bind(host.runtime);
  vi.spyOn(host.runtime, "status").mockImplementation((id) => (id === registered.data.runId ? { ...status(id)!, stepResults: steps } : status(id)));
  const envelope = await callCommand<StatusRow[]>(host, fixture.routes, "shepherd.status", { repo: REPO, pr: 1 });
  if (!envelope.ok) throw new Error(envelope.error);
  return envelope.data[0]!;
}

describe("shepherd.status stackFrozen", () => {
  it("a parent at 2 fix rounds still takes new children", async () => {
    expect((await statusAfter(2)).stackFrozen).toBe(false);
  });

  it("the 3rd fix round freezes new stacking on the parent", async () => {
    expect((await statusAfter(3)).stackFrozen).toBe(true);
  });
});
