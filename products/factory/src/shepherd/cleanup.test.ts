import { fakeGitHub, fakeSha, githubPort, type FakeGitHub, type GitHubPort, type HeadRef } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { freshReviewerBase, runCleanup, SH_CLEANUP_GIVE_UP_MS, SH_CLEANUP_RETRY_MS, type CleanupAgent, type CleanupAgents, type CleanupPorts, type CleanupTasks, type TaskState } from "./cleanup.js";
import type { AgentRow } from "@titan-design/agent-dispatch";
import { createRosterReader } from "./roster.js";
import { agentChatCleanupAgents, activeWorkTasks, type AgentChatCalls } from "./cleanup-ports.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, ShepherdStore, sliceMigration, type RegistrationInput, type ShepherdStoreRef } from "./store.js";

const REPO = "octo/demo";
const RUN = "run-1";
const IMPLEMENTER = "impl-a";
const STANDING = "rv-octo-demo-1";
const base: RegistrationInput = { repo: REPO, pr: 1, runId: RUN, task: "demo/TP-1", implementer: IMPLEMENTER, policy: OWNER_GATE_POLICY };

function storeRef(registration: RegistrationInput | undefined = base): { ref: ShepherdStoreRef; store: ShepherdStore } {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11)]);
  const store = new ShepherdStore(db, () => 0);
  if (registration) store.register(registration);
  return { store, ref: { get: () => store, bind: () => () => undefined } };
}

interface FakeAgent {
  name: string;
  exitAt: number;
  refusals?: string[];
}

/** A roster on the fake clock: an agent reads live until its `exitAt`, and leaves the roster once retired. */
function fakeAgents(clock: { now: number }, agents: FakeAgent[]): CleanupAgents & { retires: { name: string; at: number }[] } {
  const retired = new Set<string>();
  const retires: { name: string; at: number }[] = [];
  return {
    retires,
    invalidate: () => undefined,
    roster: async () => agents.filter((agent) => !retired.has(agent.name)).map((agent): CleanupAgent => ({ name: agent.name, presence: clock.now >= agent.exitAt ? "exited" : "live", status: "finished" })),
    retire: async (name) => {
      retires.push({ name, at: clock.now });
      const refusal = agents.find((agent) => agent.name === name)?.refusals?.shift();
      if (refusal !== undefined) throw new Error(refusal);
      retired.add(name);
    },
  };
}

function fakeTasks(state: TaskState): CleanupTasks & { closed: string[]; notes: string[] } {
  const closed: string[] = [];
  const notes: string[] = [];
  return { closed, notes, state: async () => state, done: async (initiative, id) => void closed.push(`${initiative}/${id}`), appendNote: async (initiative, id, line) => void notes.push(`${initiative}/${id}: ${line}`) };
}

function world(options: { fake?: FakeGitHub; port?: GitHubPort; agents?: FakeAgent[]; task?: TaskState; registration?: RegistrationInput } = {}) {
  const fake = options.fake ?? mergedPr(fakeGitHub({ repo: REPO }), { headRef: "feat/x", headRepo: REPO });
  const clock = { now: 0 };
  const agents = fakeAgents(clock, options.agents ?? []);
  const tasks = fakeTasks(options.task ?? "open");
  const { ref, store } = storeRef(options.registration);
  const cleanup: CleanupPorts = { agents, tasks };
  const deps = { port: options.port ?? githubPort(fake.wire), store: ref, now: () => clock.now, sleep: async (ms: number) => void (clock.now += ms), pollMs: 30_000, cleanup };
  const run = () => runCleanup(deps, { repo: REPO, pr: 1, runId: RUN }, new AbortController().signal);
  return { fake, clock, agents, tasks, store, run };
}

function mergedPr(fake: FakeGitHub, head: { headRef: string; headRepo: string | null }): FakeGitHub {
  fake.addPr({ ...head, headSha: fakeSha("head"), state: "closed", merged: true, mergeSha: fakeSha("merge") });
  if (!fake.refs.has(head.headRef)) fake.refs.set(head.headRef, fakeSha("head"));
  return fake;
}

describe("sh-cleanup task", () => {
  it("closes the task when the registration names no slice", async () => {
    const w = world();

    const result = await w.run();

    expect(result.task).toBe("done");
    expect(w.tasks.closed).toEqual(["demo/TP-1"]);
    expect(w.tasks.notes).toEqual([]);
  });

  it("notes the landing and leaves the task open when the registration names a slice", async () => {
    const w = world({ registration: { ...base, slice: "S4" } });

    const result = await w.run();

    expect(result.task).toBe("noted");
    expect(w.tasks.closed).toEqual([]);
    expect(w.tasks.notes).toEqual([`demo/TP-1: S4 landed in ${REPO}#1 at ${fakeSha("merge")}`]);
  });

  it("writes no landing note while the merge sha cannot be read, so a retry cannot leave two lines", async () => {
    const fake = mergedPr(fakeGitHub({ repo: REPO }), { headRef: "feat/x", headRepo: REPO });
    const real = githubPort(fake.wire);
    let reads = 0;
    const port: GitHubPort = { ...real, getPr: async (repo, pr) => (++reads === 1 ? real.getPr(repo, pr) : Promise.reject(new Error("timeout"))) };
    const w = world({ fake, port, registration: { ...base, slice: "S4" } });

    const result = await w.run();

    expect(result.task).toBe("unread");
    expect(w.tasks.notes).toEqual([]);
  });

  it("leaves a slice's task alone when it is already done", async () => {
    const w = world({ registration: { ...base, slice: "S4" }, task: "done" });

    const result = await w.run();

    expect(result.task).toBe("already-done");
    expect(w.tasks.notes).toEqual([]);
  });
});

describe("sh-cleanup head ref", () => {
  it("deletes a same-repo head branch after the merge", async () => {
    const w = world();

    const result = await w.run();

    expect(result.ref).toBe("deleted");
    expect(w.fake.refs.has("feat/x")).toBe(false);
  });

  it("asks to delete a fork head in the head repo, so a base branch of the same name survives", async () => {
    const fake = mergedPr(fakeGitHub({ repo: REPO }), { headRef: "feat/x", headRepo: "someone/demo" });
    const port = githubPort(fake.wire);
    const deleteRef = vi.spyOn(port, "deleteRef");
    const w = world({ fake, port });

    const result = await w.run();

    expect(deleteRef).toHaveBeenCalledWith(REPO, { branch: "feat/x", repo: "someone/demo" } satisfies HeadRef);
    expect(result.ref).toBe("fork-head");
    expect(fake.refs.has("feat/x")).toBe(true);
    expect(fake.effects.deleteRef).toBe(0);
  });

  it("skips a head that is the default branch and deletes nothing", async () => {
    const fake = mergedPr(fakeGitHub({ repo: REPO }), { headRef: "main", headRepo: REPO });
    const w = world({ fake });

    const result = await w.run();

    expect(result.ref).toBe("default-branch");
    expect(fake.refs.has("main")).toBe(true);
    expect(fake.effects.deleteRef).toBe(0);
  });

  it("counts a head that is already gone as done", async () => {
    const w = world();
    w.fake.refs.delete("feat/x");

    expect((await w.run()).ref).toBe("absent");
  });
});

describe("sh-cleanup hold", () => {
  it("releases a hold its reviewer satisfied once the PR has landed", async () => {
    const w = world();
    w.store.hold(RUN, "awaiting a named review", "rv-sec");
    w.store.satisfyHold(RUN, "rv-sec", fakeSha("head"), { agentId: "agent-rv", sessionId: "session-rv", locator: {} });

    await w.run();

    expect(w.store.byRun(RUN)).toMatchObject({ held: false, holdReviewer: null, holdSatisfied: null });
  });

  it("keeps the hold on a PR that has not merged", async () => {
    const fake = fakeGitHub({ repo: REPO });
    fake.addPr({ headRef: "feat/x", headSha: fakeSha("head") });
    const w = world({ fake });
    w.store.hold(RUN, "awaiting a named review", "rv-sec");

    await w.run();

    expect(w.store.byRun(RUN)?.held).toBe(true);
  });
});

describe("sh-cleanup task", () => {
  it("marks the registration's open task done", async () => {
    const w = world({ task: "open" });

    const result = await w.run();

    expect(result.task).toBe("done");
    expect(w.tasks.closed).toEqual(["demo/TP-1"]);
  });

  it("does not close a task that is already done", async () => {
    const w = world({ task: "done" });

    const result = await w.run();

    expect(result.task).toBe("already-done");
    expect(w.tasks.closed).toEqual([]);
  });

  it("closes nothing for a task that the initiative does not list", async () => {
    const w = world({ task: "missing" });

    expect((await w.run()).task).toBe("missing");
    expect(w.tasks.closed).toEqual([]);
  });
});

describe("sh-cleanup retire", () => {
  const policy: EffectivePolicy = { ...OWNER_GATE_POLICY, reviewer: STANDING };

  it("retires successors, then the implementer, then fresh reviewers, and never the standing reviewer", async () => {
    const names = [IMPLEMENTER, `${IMPLEMENTER}-s1`, `${IMPLEMENTER}-s2`, "rv-octo-demo-1-2", STANDING, "rv-octo-demo-12", "x-rv-octo-demo-1", "rv-other-demo-1", `old-${IMPLEMENTER}-s3`, `${IMPLEMENTER}-s1x`];
    const w = world({ registration: { ...base, policy }, agents: names.map((name) => ({ name, exitAt: 0 })) });

    const result = await w.run();

    expect(result.retired).toEqual([`${IMPLEMENTER}-s2`, `${IMPLEMENTER}-s1`, IMPLEMENTER, "rv-octo-demo-1-2"]);
    expect(w.agents.retires.map((retire) => retire.name)).not.toContain(STANDING);
  });

  it("retires no sooner than 3 minutes after the agent is seen exited", async () => {
    const exitAt = 7 * 60_000;
    const w = world({ agents: [{ name: IMPLEMENTER, exitAt }] });

    await w.run();

    expect(w.agents.retires).toHaveLength(1);
    expect(w.agents.retires[0]!.at).toBe(exitAt + 3 * 60_000);
  });

  it("retires an agent that is already exited at the moment it is first seen only after the literal 3 minute grace", async () => {
    const w = world({ agents: [{ name: IMPLEMENTER, exitAt: 0 }] });

    await w.run();

    expect(w.agents.retires.map((retire) => retire.at)).toEqual([180_000]);
  });

  it("counts an agent the broker no longer knows as retired", async () => {
    const w = world({ agents: [{ name: IMPLEMENTER, exitAt: 0, refusals: ['no agent named "impl-a"'] }] });

    const result = await w.run();

    expect(result.retired).toEqual([IMPLEMENTER]);
    expect(result.caveats).toEqual([]);
    expect(w.agents.retires).toHaveLength(1);
  });

  it("counts an agent the broker reports as already retired as retired, without a second try", async () => {
    const w = world({ agents: [{ name: IMPLEMENTER, exitAt: 0, refusals: ["Already Retired"] }] });

    const result = await w.run();

    expect(result.retired).toEqual([IMPLEMENTER]);
    expect(w.agents.retires).toHaveLength(1);
  });

  it("does not take an unrelated refusal that merely mentions an agent for a retired one", async () => {
    const w = world({ agents: [{ name: IMPLEMENTER, exitAt: 0, refusals: ["worktree of agent named impl-a is dirty"] }] });

    await w.run();

    expect(w.agents.retires).toHaveLength(2);
  });

  it("still closes the task and retires the agent after a GitHub outage used up its hour", async () => {
    const fake = mergedPr(fakeGitHub({ repo: REPO }), { headRef: "feat/x", headRepo: REPO });
    const port = githubPort(fake.wire);
    vi.spyOn(port, "getPr").mockRejectedValue(new Error("github is down"));
    const w = world({ fake, port, agents: [{ name: IMPLEMENTER, exitAt: 0 }] });

    const result = await w.run();

    expect(result).toMatchObject({ ref: "unread", task: "done", retired: [IMPLEMENTER] });
    expect(result.caveats).toEqual(["head ref of #1: github is down"]);
    expect(w.agents.retires[0]!.at).toBeGreaterThanOrEqual(SH_CLEANUP_GIVE_UP_MS + 180_000);
  });

  it("retries a refusal at most every 10 minutes and finishes with a caveat after an hour", async () => {
    const refusals = Array.from({ length: 20 }, () => "worktree has unpushed commits");
    const w = world({ agents: [{ name: IMPLEMENTER, exitAt: 0, refusals }] });

    const result = await w.run();

    const gaps = w.agents.retires.slice(1).map((retire, i) => retire.at - w.agents.retires[i]!.at);
    expect(gaps.every((gap) => gap >= SH_CLEANUP_RETRY_MS)).toBe(true);
    expect(w.clock.now).toBeGreaterThanOrEqual(SH_CLEANUP_GIVE_UP_MS);
    expect(result.retired).toEqual([]);
    expect(result.caveats).toEqual([`retire ${IMPLEMENTER}: worktree has unpushed commits`]);
  });

  it("does not retire an agent resumed inside the roster cache window", async () => {
    const clock = { now: 0 };
    const rowAt = (): AgentRow => ({ name: IMPLEMENTER, agentId: "id", state: "live", presence: clock.now < 100_000 ? "exited" : "live", status: "finished", profile: "implementer", surface: "headless", model: null, cwd: "/repo", sessionId: "s", transcriptPath: null, transcriptExists: false, spawnedBy: null, account: null, generation: 1, teleportFrom: null });
    const calls: AgentChatCalls = { listAgents: vi.fn(async () => [rowAt()]), retire: vi.fn(() => ({ name: IMPLEMENTER, caveats: [] })) };
    const roster = createRosterReader(async () => calls.listAgents("/bin/agent-chat", 1_000), { now: () => clock.now, ttlMs: SH_CLEANUP_GIVE_UP_MS * 2 });
    const agents = agentChatCleanupAgents("/bin/agent-chat", calls, 1_000, roster);
    const w = world();
    const deps = { port: githubPort(w.fake.wire), store: storeRef().ref, now: () => clock.now, sleep: async (ms: number) => void (clock.now += ms), pollMs: 30_000, cleanup: { agents, tasks: fakeTasks("open") } };

    const result = await runCleanup(deps, { repo: REPO, pr: 1, runId: RUN }, new AbortController().signal);

    expect(calls.retire).not.toHaveBeenCalled();
    expect(result.retired).toEqual([]);
  });

  it("does not retire when the fresh roster read right before the retire is unreadable, and says so", async () => {
    const w = world({ agents: [{ name: IMPLEMENTER, exitAt: 0 }] });
    let fresh = false;
    const cachedRoster = w.agents.roster;
    w.agents.invalidate = () => void (fresh = true);
    w.agents.roster = async () => {
      if (fresh) {
        fresh = false;
        throw new Error("broker unreachable");
      }
      return cachedRoster();
    };

    const result = await w.run();

    expect(w.agents.retires).toEqual([]);
    expect(result.retired).toEqual([]);
    expect(result.caveats).toEqual([`retire ${IMPLEMENTER}: roster unreadable before retire: broker unreachable`]);
  });

  it("leaves the task and the agents alone when no ports are wired", async () => {
    const w = world({ agents: [{ name: IMPLEMENTER, exitAt: 0 }] });
    const deps = { port: githubPort(w.fake.wire), store: storeRef().ref, now: () => 0, sleep: async () => undefined };

    const result = await runCleanup(deps, { repo: REPO, pr: 1, runId: RUN }, new AbortController().signal);

    expect(result).toMatchObject({ ref: "deleted", task: "no cleanup ports wired", retired: [] });
  });
});

describe("fresh reviewer names", () => {
  it("keeps the repo owner, so two owners' same-named repos get distinct names", () => {
    expect(freshReviewerBase("a/demo", 1)).toBe("rv-a-demo-1");
    expect(freshReviewerBase("b/demo", 1)).toBe("rv-b-demo-1");
  });
});

describe("cleanup ports", () => {
  it("retires through agent-chat without --force", async () => {
    const calls: AgentChatCalls = { listAgents: vi.fn(async () => []), retire: vi.fn(() => ({ name: IMPLEMENTER, caveats: [] })) };

    await agentChatCleanupAgents("/bin/agent-chat", calls, 1_000).retire(IMPLEMENTER);

    expect(calls.retire).toHaveBeenCalledTimes(1);
    const options = vi.mocked(calls.retire).mock.calls[0]![3];
    expect(options?.force).not.toBe(true);
  });

  it("reads a task's state from its initiative's list and closes it over loopback rpc", async () => {
    const bodies: { url: string; body: unknown }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      bodies.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      const data = String(url).endsWith("task.list") ? { tasks: [{ id: "TP-1", status: "done" }, { id: "TP-2", status: "open" }] } : {};
      return new Response(JSON.stringify({ ok: true, data }));
    });
    const tasks = activeWorkTasks({ origin: "http://127.0.0.1:7400", fetch });

    const states = [await tasks.state("demo", "TP-1"), await tasks.state("demo", "TP-2"), await tasks.state("demo", "TP-3")];
    await tasks.done("demo", "TP-2");

    expect(states).toEqual(["done", "open", "missing"]);
    expect(bodies.at(-1)).toEqual({ url: "http://127.0.0.1:7400/rpc/task.done", body: { slug: "demo", id: "TP-2" } });
    expect(bodies[0]!.body).toEqual({ slug: "demo", status: "all" });
  });

  it("appends a note to the task's notes once, through task.edit", async () => {
    const bodies: { url: string; body: unknown }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      bodies.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, data: { tasks: [{ id: "TP-2", status: "open", notes: "first" }] } }));
    });
    const tasks = activeWorkTasks({ origin: "http://127.0.0.1:7400", fetch });

    await tasks.appendNote("demo", "TP-2", "S1 landed");
    await tasks.appendNote("demo", "TP-2", "first");

    const edits = bodies.filter((call) => call.url.endsWith("task.edit"));
    expect(edits).toEqual([{ url: "http://127.0.0.1:7400/rpc/task.edit", body: { slug: "demo", id: "TP-2", field: "notes", value: "first\nS1 landed" } }]);
  });
});
