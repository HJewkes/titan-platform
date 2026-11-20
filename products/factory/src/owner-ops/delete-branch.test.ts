import type { AgentRow } from "@titan-design/agent-dispatch";
import { FakeHttpError, fakeGitHub, fakeSha, githubPort, type FakeGitHub } from "@titan-design/github";
import type { OwnerOp } from "@titan-design/owner-queue";
import { describe, expect, it } from "vitest";
import type { Outcome } from "../console-action/outcome.js";
import { branchNameProblem, deleteBranch, type DeleteBranchDeps } from "./delete-branch.js";

const REPO = "example-org/example-repo";
const BRANCH = "scratch/spike";
const TIP = fakeSha("scratch-tip");
const CONFIRM = `action:${"d".repeat(64)}`;

type DeleteOp = Extract<OwnerOp, { kind: "delete-branch" }>;

const agent = (over: Partial<AgentRow> = {}): AgentRow => ({
  name: "item-42", agentId: "9e3faa6c", state: "live", presence: "live", status: "running", profile: "headless-implementer",
  surface: "headless", cwd: "/work/tree", sessionId: "s-1", generation: 1, ...over,
});

interface World {
  fake: FakeGitHub;
  deps: DeleteBranchDeps;
  runs: { repo: string; branch: string | null; runId: string; status: string }[];
  roster: AgentRow[] | Error;
  doneBefore: object[];
  tap(over?: Partial<DeleteOp>): Promise<Outcome>;
}

/** The fake answers a protection read on any name; gh-cli's Rest.get throws on GitHub's 404 for a branch that is not there. */
function liveWire(fake: FakeGitHub): FakeGitHub["wire"] {
  const getBranchProtected: FakeGitHub["wire"]["getBranchProtected"] = async (repo, branch) => {
    if (!fake.refs.has(branch)) throw new FakeHttpError(404, "Branch not found");
    return fake.wire.getBranchProtected(repo, branch);
  };
  return { ...fake.wire, getBranchProtected };
}

function world(base = "main"): World {
  const fake = fakeGitHub({ base, repo: REPO });
  fake.rules = { contexts: [], strict: false };
  fake.refs.set(BRANCH, TIP);
  const state: Pick<World, "runs" | "roster" | "doneBefore"> = { runs: [], roster: [], doneBefore: [] };
  const deps: DeleteBranchDeps = {
    port: githubPort(liveWire(fake)),
    host: { runtime: { status: (runId) => ({ status: state.runs.find((run) => run.runId === runId)?.status ?? "completed" }) } },
    services: { store: { get: () => ({ all: () => state.runs }) } },
    agentChat: { list: async () => (state.roster instanceof Error ? Promise.reject(state.roster) : state.roster) },
    branches: { prefixes: ["scratch/"], repos: [REPO] },
    done: async () => state.doneBefore,
  };
  const tap = (over: Partial<DeleteOp> = {}) => deleteBranch("act-1", { op: { kind: "delete-branch", repo: REPO, branch: BRANCH, tipSha: TIP, ...over }, confirmEvent: CONFIRM }, deps);
  return Object.assign(state, { fake, deps, tap });
}

const refusedWith = (detail: string) => ({ outcome: "refused", reason: "class", detail });

describe("delete-branch op", () => {
  it("deletes a scratch branch at the confirmed tip and reports the sha the restore line uses", async () => {
    const w = world();

    const outcome = await w.tap();

    expect(outcome).toEqual({ outcome: "deleted", branch: BRANCH, tipSha: TIP });
    expect(w.fake.refs.has(BRANCH)).toBe(false);
    expect(w.fake.effects.deleteRef).toBe(1);
  });

  it("refuses a repo outside the managed list, case aside, and deletes nothing", async () => {
    const w = world();
    w.deps.branches = { prefixes: ["scratch/"], repos: ["example-org/other-repo"] };

    expect(await w.tap()).toEqual(refusedWith("not a repo this console manages"));
    expect(w.fake.effects.deleteRef).toBe(0);
  });

  it("refuses every delete when serve has no branch policy", async () => {
    const w = world();
    w.deps.branches = undefined;

    expect(await w.tap()).toEqual(refusedWith("not a repo this console manages"));
    expect(w.fake.effects.deleteRef).toBe(0);
  });

  it.each(["scratch/../main", "-scratch/x", "scratch/x.lock", "scratch/a b", "scratch/x@{1}", "scratch//x", "scratch/.hidden", "scratch/a\u0007b"])("refuses the invalid name %s and deletes nothing", async (branch) => {
    const w = world();

    expect(await w.tap({ branch })).toEqual(refusedWith("not a valid branch name"));
    expect(w.fake.effects.deleteRef).toBe(0);
  });

  it.each(["feat/x", "Scratch/x", "refs/heads/scratch/x", "scratchy/x"])("refuses %s, which carries no allowed prefix", async (branch) => {
    const w = world();
    w.fake.refs.set(branch, TIP);

    expect(await w.tap({ branch })).toEqual(refusedWith("only scratch/ branches are deleted from the console"));
    expect(w.fake.effects.deleteRef).toBe(0);
  });

  it("refuses the default branch even when it carries an allowed prefix", async () => {
    const w = world(BRANCH);

    expect(await w.tap()).toEqual(refusedWith("the default branch is never deleted"));
    expect(w.fake.effects.deleteRef).toBe(0);
  });

  it("refuses a branch GitHub reports protected", async () => {
    const w = world();
    w.fake.branchProtected = true;

    expect(await w.tap()).toEqual(refusedWith("protected branches are never deleted"));
    expect(w.fake.effects.deleteRef).toBe(0);
  });

  it("refuses a branch a ruleset requires checks on", async () => {
    const w = world();
    w.fake.rules = { contexts: ["validate"], strict: false };

    expect(await w.tap()).toEqual(refusedWith("protected branches are never deleted"));
    expect(w.fake.effects.deleteRef).toBe(0);
  });

  it("refuses a branch an open PR has as its head", async () => {
    const w = world();
    const pull = w.fake.addPr({ headRef: BRANCH, headSha: TIP });

    expect(await w.tap()).toEqual(refusedWith(`${REPO}#${pull.number} is open on this branch`));
    expect(w.fake.effects.deleteRef).toBe(0);
  });

  it("refuses a branch a stacked child PR targets as its base", async () => {
    const w = world();
    const child = w.fake.addPr({ headRef: "feat/child", baseRef: BRANCH, headSha: fakeSha("child") });

    expect(await w.tap()).toEqual(refusedWith(`${REPO}#${child.number} targets this branch`));
    expect(w.fake.effects.deleteRef).toBe(0);
  });

  it("refuses a branch a live Shepherd run is registered on, and allows one whose run has ended", async () => {
    const w = world();
    w.runs.push({ repo: REPO.toUpperCase(), branch: BRANCH, runId: "run-1", status: "running" });

    expect(await w.tap()).toEqual(refusedWith("Shepherd run run-1 is on this branch"));
    expect(w.fake.effects.deleteRef).toBe(0);

    w.runs[0]!.status = "completed";
    expect(await w.tap()).toMatchObject({ outcome: "deleted" });
  });

  it("refuses an agent's own agent-chat branch while the agent holds the name", async () => {
    const w = world();
    const branch = "agent-chat/item-42";
    w.fake.refs.set(branch, TIP);
    w.deps.branches = { prefixes: ["agent-chat/"], repos: [REPO] };
    w.roster = [agent()];

    expect(await w.tap({ branch })).toEqual(refusedWith("item-42 is working on this branch"));
    expect(w.fake.effects.deleteRef).toBe(0);
  });

  it("refuses with agent-chat-unavailable when the roster cannot be read, and deletes nothing", async () => {
    const w = world();
    w.roster = new Error("could not reach or start the agent-chat broker");

    expect(await w.tap()).toEqual({ outcome: "refused", reason: "agent-chat-unavailable", detail: "could not reach or start the agent-chat broker" });
    expect(w.fake.effects.deleteRef).toBe(0);
  });

  it("refuses with agent-chat-unavailable when serve has no agent-chat", async () => {
    const w = world();
    w.deps.agentChat = undefined;

    expect(await w.tap()).toMatchObject({ outcome: "refused", reason: "agent-chat-unavailable" });
    expect(w.fake.effects.deleteRef).toBe(0);
  });

  it("answers moved with the current tip when the branch moved since the owner confirmed, and deletes nothing", async () => {
    const w = world();
    const moved = fakeSha("pushed-since");
    w.fake.refs.set(BRANCH, moved);

    expect(await w.tap()).toEqual({ outcome: "moved", currentHead: moved });
    expect(w.fake.refs.get(BRANCH)).toBe(moved);
    expect(w.fake.effects.deleteRef).toBe(0);
  });

  it("answers gone for an absent branch this record did not delete", async () => {
    const w = world();
    w.fake.refs.delete(BRANCH);

    expect(await w.tap()).toEqual({ outcome: "gone", reason: `${BRANCH} is not on ${REPO}` });
  });

  it("answers already for an absent branch this very record deleted", async () => {
    const w = world();
    w.fake.refs.delete(BRANCH);
    w.doneBefore = [{ outcome: "deleted", branch: BRANCH, tipSha: TIP }];

    expect(await w.tap()).toEqual({ outcome: "already", branch: BRANCH });
  });

  it("refuses with github-unreadable when a GitHub read fails, and deletes nothing", async () => {
    const w = world();
    w.fake.readFaults.getDefaultBranch = [new Error("HTTP 502")];

    expect(await w.tap()).toMatchObject({ outcome: "refused", reason: "github-unreadable" });
    expect(w.fake.effects.deleteRef).toBe(0);
  });
});

describe("branchNameProblem", () => {
  it("accepts a plain nested branch name", () => {
    expect(branchNameProblem("scratch/tp-1/spike_2")).toBe(false);
  });
});
