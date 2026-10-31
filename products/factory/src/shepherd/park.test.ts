import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchError, type AgentRow } from "@titan-design/agent-dispatch";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExitNoticePorts } from "./exit-notice.js";
import {
  parkOnce,
  parkImplementer,
  parkRoutes,
  parkStep,
  rearmRecorded,
  type ParkPort,
} from "./park.js";
import { liveRetry, type LiveRetryDeps } from "./park-retry.js";
import { createRosterReader, type RosterReader } from "./roster.js";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { OWNER_GATE_POLICY } from "./policy.js";
import { ShepherdStore, lineageMigration, parkSettledMigration, shepherdMigration, sliceMigration, type ShepherdStoreRef } from "./store.js";
import { partialFake } from "@titan-design/test-kit";

interface Registered {
  implementer?: string;
  branch?: string | null;
  seat?: string;
  successors?: string[];
  reviewer?: string;
  settled?: (runId: string, headSha: string, agent: string) => boolean;
}

const storeWith = ({
  implementer,
  branch = null,
  seat = "demo-seat",
  successors = [],
  reviewer,
  settled = () => false,
}: Registered = {}) =>
  (Object.assign(partialFake<ShepherdStoreRef>(), {
    get: () => ({
      byRun: () =>
        implementer
          ? {
              implementer,
              branch,
              repo: "o/r",
              pr: 7,
              runId: "run-1",
              policy: { seat, reviewer },
            }
          : undefined,
      authorsOf: () => successors.map((name) => ({ name, role: "successor" })),
      parkSettled: settled,
      settlePark: () => undefined,
    }),
  }));
const input = { runId: "run-1", headSha: "a".repeat(40) };

const refusing =
  (reasons: Record<string, string>, asked: string[] = []): ParkPort =>
  async (name) => {
    asked.push(name);
    const reason = reasons[name];
    if (reason === undefined) return { lines: [`Parked ${name}.`] };
    throw new DispatchError(
      `agent-chat refused agent park: Not parked: ${reason}`
    );
  };

function noticePorts(
  hubSeat?: string
): ExitNoticePorts & { sent: [string, string][] } {
  const sent: [string, string][] = [];
  return {
    sent,
    seatFor: () => undefined,
    hubSeat: () => hubSeat,
    lastReport: async () => undefined,
    send: async (seat, text) => void sent.push([seat, text]),
  };
}

const LIVE = (name: string) =>
  `${name} is live; park takes only an agent whose process has exited or that this broker no longer tracks`;

describe("parkImplementer", () => {
  it("skips without asking the broker when no registration names an implementer", async () => {
    const asked: string[] = [];
    const park: ParkPort = async (name) => (asked.push(name), { lines: [] });

    const outcome = await parkImplementer(storeWith(), park, input);

    expect(outcome).toEqual({
      kind: "skipped",
      reason: "no registration names the implementer",
    });
    expect(asked).toEqual([]);
  });

  it("answers a thrown non-Error as not parked rather than failing the step", async () => {
    const park: ParkPort = async () => {
      throw "socket closed";
    };

    expect(
      await parkImplementer(storeWith({ implementer: "impl-a" }), park, input)
    ).toEqual({
      kind: "not-parked",
      agent: "impl-a",
      reason: "socket closed",
      brokerDown: false,
    });
  });

  it("counts a tree that is already off disk as parked", async () => {
    const park = refusing({
      "impl-a": "/tmp/tree is not on disk; nothing to park",
    });

    const outcome = await parkImplementer(
      storeWith({ implementer: "impl-a" }),
      park,
      input
    );

    expect(outcome).toMatchObject({
      kind: "parked",
      agent: "impl-a",
      alreadyGone: true,
    });
  });

  it("counts a tree agent-chat never allocated as parked", async () => {
    const park = refusing({
      "impl-a": "impl-a holds no worktree agent-chat allocated",
    });

    const outcome = await parkImplementer(
      storeWith({ implementer: "impl-a" }),
      park,
      input
    );

    expect(outcome).toMatchObject({
      kind: "parked",
      agent: "impl-a",
      alreadyGone: true,
    });
  });

  it("parks the successor and the agent its agent-chat branch was allocated to when the registered name is unknown", async () => {
    const asked: string[] = [];
    const park = refusing(
      { "seat-label": 'no agent named "seat-label"' },
      asked
    );

    const outcome = await parkImplementer(
      storeWith({
        implementer: "seat-label",
        branch: "agent-chat/impl-b",
        successors: ["impl-a-s1"],
      }),
      park,
      input
    );

    expect(asked).toEqual(["impl-a-s1", "seat-label", "impl-b"]);
    expect(outcome).toEqual({
      kind: "parked",
      agent: "impl-a-s1, impl-b",
      lines: ["Parked impl-a-s1.", "Parked impl-b."],
    });
  });
});

describe("parkStep", () => {
  it("tells the run's seat in one line why a tree was not parked", async () => {
    const notice = noticePorts("hub");
    const park = refusing({
      "impl-a": "uncommitted or untracked changes in /tmp/tree",
    });

    const outcome = await parkStep(
      storeWith({ implementer: "impl-a" }),
      { park, notice },
      input
    );

    expect(notice.sent).toEqual([
      [
        "demo-seat",
        "Shepherd: o/r#7: impl-a's worktree was not parked: agent-chat refused agent park: Not parked: uncommitted or untracked changes in /tmp/tree",
      ],
    ]);
    expect(outcome).toMatchObject({
      kind: "not-parked",
      notice: "sent to demo-seat",
    });
  });

  it("falls back to the hub seat when the run's policy names no seat", async () => {
    const notice = noticePorts("hub");
    const park = refusing({
      "impl-a": "uncommitted or untracked changes in /tmp/tree",
    });

    await parkStep(
      storeWith({ implementer: "impl-a", seat: "none" }),
      { park, notice },
      input
    );

    expect(notice.sent.map(([seat]) => seat)).toEqual(["hub"]);
  });

  it("skips without a notice when the broker no longer knows the only candidate", async () => {
    const notice = noticePorts("hub");
    const park = refusing({ "impl-a": 'no agent named "impl-a"' });

    const outcome = await parkStep(
      storeWith({ implementer: "impl-a" }),
      { park, notice },
      input
    );

    expect(outcome).toMatchObject({ kind: "skipped" });
    expect(outcome).not.toHaveProperty("notice");
    expect(notice.sent).toEqual([]);
  });

  it("holds a live agent's refusal for a retry at its exit instead of telling the seat", async () => {
    const notice = noticePorts("hub");
    const armed: string[] = [];
    const retry = { arm: (agent: string) => void armed.push(agent) };

    const outcome = await parkStep(
      storeWith({ implementer: "impl-a" }),
      { park: refusing({ "impl-a": LIVE("impl-a") }), notice, retry },
      input
    );

    expect(outcome).toMatchObject({ kind: "not-parked", retry: "at-exit" });
    expect(armed).toEqual(["impl-a"]);
    expect(notice.sent).toEqual([]);
  });

  it("tells the seat when the retry at exit still leaves the tree standing", async () => {
    const notice = noticePorts();
    let settling: Promise<void> | undefined;
    const retry = {
      arm: (
        agent: string,
        settle: (settled: {
          agent: string;
          parked: boolean;
          detail: string;
        }) => Promise<void>
      ) => (settling = settle({ agent, parked: false, detail: "still dirty" })),
    };

    await parkStep(
      storeWith({ implementer: "impl-a" }),
      { park: refusing({ "impl-a": LIVE("impl-a") }), notice, retry },
      input
    );
    await settling;

    expect(notice.sent).toEqual([
      [
        "demo-seat",
        "Shepherd: o/r#7: impl-a's worktree was not parked: still dirty",
      ],
    ]);
  });
});

describe("liveRetry", () => {
  function retryWorld(
    presences: string[],
    attempts: Awaited<ReturnType<LiveRetryDeps["attempt"]>>[]
  ) {
    const tried: string[] = [];
    let clock = 0;
    const deps: LiveRetryDeps = {
      attempt: async (name) => (
        tried.push(name),
        attempts.shift() ?? { done: true, parked: true, detail: "parked" }
      ),
      presence: async () => presences.shift(),
      wait: async (ms) => void (clock += ms),
      now: () => clock,
      pollMs: 10,
      giveUpMs: 1_000,
    };
    return { tried, retry: liveRetry(deps) };
  }

  it("parks only once the agent has exited", async () => {
    const { tried, retry } = retryWorld(["live", "live", "exited"], []);
    const settled: unknown[] = [];

    await retry.arm("impl-a", async (result) => void settled.push(result));

    expect(tried).toEqual(["impl-a"]);
    expect(settled).toEqual([
      { agent: "impl-a", parked: true, detail: "parked" },
    ]);
  });

  it("settles as not parked when the agent is still live at the give-up", async () => {
    const { tried, retry } = retryWorld(Array<string>(200).fill("live"), []);
    const settled: { parked: boolean }[] = [];

    await retry.arm("impl-a", async (result) => void settled.push(result));

    expect(tried).toEqual([]);
    expect(settled).toMatchObject([{ parked: false }]);
  });

  it("waits once per agent however often it is armed", async () => {
    const { tried, retry } = retryWorld(["exited"], []);

    const first = retry.arm("impl-a", async () => undefined);
    const second = retry.arm("impl-a", async () => undefined);
    await first;

    expect(second).toBeUndefined();
    expect(tried).toEqual(["impl-a"]);
  });
});

describe("rearmRecorded", () => {
  it("re-arms the exit retry when a restart replays a live agent's recorded refusal", async () => {
    const armed: string[] = [];
    parkRoutes(
      {
        store: storeWith({ implementer: "impl-a" }),
        now: () => 0,
        agentChatBin: "agent-chat",
      },
      refusing({}),
      { arm: (agent) => void armed.push(agent) }
    );
    const recorded = {
      kind: "not-parked",
      agent: "impl-a",
      reason: LIVE("impl-a"),
      brokerDown: false,
      retry: "at-exit",
    };

    rearmRecorded("run-1", input.headSha, recorded);

    expect(armed).toEqual(["impl-a"]);
  });

  const settledAt = (head: string): ShepherdStoreRef =>
    storeWith({ implementer: "impl-a", settled: (runId, headSha, agent) => runId === "run-1" && headSha === head && agent === "impl-a" });
  const replayArmed = (store: ShepherdStoreRef, head: string): string[] => {
    const armed: string[] = [];
    parkRoutes({ store, now: () => 0, agentChatBin: "agent-chat" }, refusing({}), { arm: (agent) => void armed.push(agent) });
    rearmRecorded("run-1", head, { kind: "not-parked", agent: "impl-a", reason: LIVE("impl-a"), brokerDown: false, retry: "at-exit" });
    return armed;
  };

  it("arms nothing when the refusal's retry already settled at this head", () => {
    expect(replayArmed(settledAt(input.headSha), input.headSha)).toEqual([]);
  });

  it("re-arms a later head's refusal even though an earlier head's retry settled", () => {
    expect(replayArmed(settledAt(input.headSha), "b".repeat(40))).toEqual(["impl-a"]);
  });
});

describe("parkStep reviewer trees", () => {
  const row = (
    name: string,
    presence: string,
    status = "finished"
  ): AgentRow => ({
    name,
    agentId: name,
    state: presence,
    presence,
    status,
    profile: "reviewer",
    surface: "headless",
    model: null,
    cwd: "",
    sessionId: "",
    transcriptPath: null,
    transcriptExists: false,
    spawnedBy: null,
    account: null,
    generation: 1,
    teleportFrom: null,
  });
  const rosterOf = (rows: AgentRow[]): RosterReader =>
    createRosterReader(async () => rows);
  const wiringFor = (
    rows: AgentRow[],
    park: ParkPort,
    notice?: ExitNoticePorts
  ) => ({ park, roster: rosterOf(rows), notice });
  const ROUNDS = [
    row("rv-o-r-7", "exited"),
    row("rv-o-r-7-2", "exited"),
    row("rv-o-r-7-3", "live", "running"),
    row("rv-o-r-70", "exited"),
    row("rv-o-r-7-4", "exited", "retired"),
  ];

  it("parks the exited reviewers of this pull request and leaves a running round's tree", async () => {
    const asked: string[] = [];

    const outcome = await parkStep(
      storeWith({ implementer: "impl-a" }),
      wiringFor(ROUNDS, refusing({}, asked)),
      input
    );

    expect(asked).toEqual(["rv-o-r-7", "rv-o-r-7-2", "impl-a"]);
    expect(outcome.reviewers.map((parked) => parked.kind)).toEqual([
      "parked",
      "parked",
    ]);
  });

  it("parks no reviewer and logs when the roster read fails, then parks them on the next tick", async () => {
    const asked: string[] = [];
    let down = true;
    const roster = createRosterReader(async () => (down ? Promise.reject(new Error("broker down")) : ROUNDS));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await parkStep(storeWith({ implementer: "impl-a" }), { park: refusing({}, asked), roster, notice: undefined }, input);
    expect(asked).toEqual(["impl-a"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("roster could not be read"));

    down = false;
    await parkStep(storeWith({ implementer: "impl-a" }), { park: refusing({}, asked), roster, notice: undefined }, input);
    expect(asked).toEqual(["impl-a", "rv-o-r-7", "rv-o-r-7-2", "impl-a"]);
    log.mockRestore();
  });

  it("parks the exited panel members of this pull request's reviewers, and of its standing reviewer, at the round end", async () => {
    const asked: string[] = [];
    const members = [
      row("rv-o-r-7-adversary", "exited"),
      row("rv-o-r-7-2-perf", "exited"),
      row("rv-o-r-7-tests-2", "exited"),
      row("rv-o-r-7-2-tests", "live", "running"),
      row("rv-o-r-70-adversary", "exited"),
      row("rv-o-r-7-review", "exited"),
    ];

    await parkStep(storeWith({ implementer: "impl-a" }), wiringFor(members, refusing({}, asked)), input);

    expect(asked).toEqual(["rv-o-r-7-adversary", "rv-o-r-7-2-perf", "rv-o-r-7-tests-2", "impl-a"]);
  });

  it("tells the seat when a reviewer's tree is dirty and asks again at the next round end", async () => {
    const notice = noticePorts("hub");
    const refused = refusing({
      "rv-o-r-7": "worktree has uncommitted changes",
    });
    const wiring = wiringFor([row("rv-o-r-7", "exited")], refused, notice);

    const first = await parkStep(
      storeWith({ implementer: "impl-a" }),
      wiring,
      input
    );
    const second = await parkStep(
      storeWith({ implementer: "impl-a" }),
      wiring,
      input
    );

    expect(first.reviewers).toMatchObject([
      { kind: "not-parked", agent: "rv-o-r-7" },
    ]);
    expect(second.reviewers).toMatchObject([
      { kind: "not-parked", agent: "rv-o-r-7" },
    ]);
    expect(notice.sent).toHaveLength(2);
    expect(notice.sent[0]?.[1]).toContain("rv-o-r-7's worktree was not parked");
  });

  it.each([
    ["a retired agent", 'no agent named "rv-o-r-7"'],
    ["a tree outside agent-chat", "rv-o-r-7 holds no worktree agent-chat allocated"],
  ])("records %s once as already gone, sends no notice and never asks again", async (label, reason) => {
    const notice = noticePorts("hub");
    const asked: string[] = [];
    const wiring = wiringFor(
      [row("rv-o-r-7", "exited")],
      refusing({ "rv-o-r-7": reason }, asked),
      notice
    );

    const own = { ...input, runId: `run-${label}` };
    const first = await parkStep(storeWith({ implementer: "impl-a" }), wiring, own);
    const gone = first.reviewers.flatMap((parked) => (parked.kind === "parked" ? [parked.agent] : []));
    const second = await parkStep(storeWith({ implementer: "impl-a" }), wiring, { ...own, gone });

    expect(first.reviewers).toMatchObject([
      { kind: "parked", agent: "rv-o-r-7", alreadyGone: true },
    ]);
    expect(second.reviewers).toEqual([]);
    expect(asked.filter((name) => name === "rv-o-r-7")).toHaveLength(1);
    expect(notice.sent).toEqual([]);
  });

  it("never parks the standing reviewer", async () => {
    const asked: string[] = [];
    const store = storeWith({ implementer: "impl-a", reviewer: "rv-o-r-7" });

    await parkStep(
      store,
      wiringFor([row("rv-o-r-7", "exited")], refusing({}, asked)),
      input
    );

    expect(asked).toEqual(["impl-a"]);
  });
});

describe("an implementer retired while its park waited for its exit", () => {
  afterEach(() => vi.useRealTimers());

  it("is recorded as parked and the seat is told nothing", async () => {
    vi.useFakeTimers();
    const notice = noticePorts("hub");
    let live = true;
    const park: ParkPort = async (name) => {
      if (live) throw new DispatchError(`agent-chat refused agent park: Not parked: ${LIVE(name)}`);
      throw new DispatchError(`agent-chat refused agent park: Not parked: no agent named "${name}"`);
    };
    const [route] = parkRoutes(
      {
        store: storeWith({ implementer: "impl-a" }),
        now: () => Date.now(),
        agentChatBin: "agent-chat",
        roster: createRosterReader(async () => []),
        exitNotice: notice,
      },
      park
    );
    const step = { runId: "run-1", workflowName: "w", stepId: "sh-park:x", iteration: 0, prompt: JSON.stringify(input), signal: new AbortController().signal, attempt: 1, requestKey: "k" };

    const outcome = await route!.runner.run(step);
    live = false;
    await vi.advanceTimersByTimeAsync(61_000);

    if (!outcome.ok) throw new Error("the park step failed");
    expect(JSON.parse(outcome.output).result).toMatchObject({ kind: "not-parked", retry: "at-exit" });
    expect(notice.sent).toEqual([]);
  });

  it("stays silent each time a replay re-arms its recorded live refusal", async () => {
    vi.useFakeTimers();
    const notice = noticePorts("hub");
    const asked: string[] = [];
    parkRoutes(
      {
        store: storeWith({ implementer: "impl-a" }),
        now: () => Date.now(),
        agentChatBin: "agent-chat",
        roster: createRosterReader(async () => []),
        exitNotice: notice,
      },
      refusing({ "impl-a": 'no agent named "impl-a"' }, asked)
    );
    const recorded = { kind: "not-parked", agent: "impl-a", reason: LIVE("impl-a"), brokerDown: false, retry: "at-exit" };

    rearmRecorded("run-1", input.headSha, recorded);
    await vi.advanceTimersByTimeAsync(61_000);
    rearmRecorded("run-1", input.headSha, recorded);
    await vi.advanceTimersByTimeAsync(61_000);

    expect(asked).toEqual(["impl-a", "impl-a"]);
    expect(notice.sent).toEqual([]);
  });
});

describe("a settled park refusal across serve restarts", () => {
  afterEach(() => vi.useRealTimers());

  const DIRTY = (name: string) => `uncommitted or untracked changes in /trees/${name}`;
  const recorded = { kind: "not-parked", agent: "impl-a", reason: LIVE("impl-a"), brokerDown: false, retry: "at-exit" };

  function world(send: ExitNoticePorts["send"]) {
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), parkSettledMigration(21)]);
    const shepherd = new ShepherdStore(db);
    shepherd.register({ repo: "o/r", pr: 7, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: { ...OWNER_GATE_POLICY, seat: "demo-seat" } });
    let live = true;
    const park: ParkPort = (name) => {
      throw new DispatchError(`agent-chat refused agent park: Not parked: ${live ? LIVE(name) : DIRTY(name)}`);
    };
    const deps = {
      store: { get: () => shepherd, bind: () => () => undefined } satisfies ShepherdStoreRef,
      now: () => Date.now(),
      agentChatBin: "agent-chat",
      roster: createRosterReader(async () => []),
      exitNotice: { ...noticePorts(), send },
    };
    const restart = async () => {
      parkRoutes(deps, park);
      rearmRecorded("run-1", input.headSha, recorded);
      await vi.advanceTimersByTimeAsync(61_000);
    };
    const firstRun = async () => {
      const [route] = parkRoutes(deps, park);
      const step = { runId: "run-1", workflowName: "w", stepId: `sh-park:${input.headSha}`, iteration: 0, prompt: JSON.stringify(input), signal: new AbortController().signal, attempt: 1, requestKey: "k" };
      await route!.runner.run(step);
      live = false;
      await vi.advanceTimersByTimeAsync(61_000);
    };
    return { shepherd, firstRun, restart };
  }

  it("tells the seat about a dirty tree once, not again at each restart's replay", async () => {
    vi.useFakeTimers();
    const sent: [string, string][] = [];
    const w = world(async (seat, text) => void sent.push([seat, text]));

    await w.firstRun();
    await w.restart();
    await w.restart();

    expect(sent).toHaveLength(1);
    expect(sent[0]![1]).toMatch(/not parked: .*uncommitted/);
  });

  it("stores the settle before the notice, so a notice that failed is not retried after a restart", async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    let failing = true;
    const w = world(async (_seat, text) => {
      if (failing) throw new Error("broker down");
      sent.push(text);
    });

    await w.firstRun();
    failing = false;
    await w.restart();

    expect(sent).toEqual([]);
    expect(w.shepherd.parkSettled("run-1", input.headSha, "impl-a")).toBe(true);
  });
});

describe("parkOnce", () => {
  it("hands each later head the reviewers an earlier head's record found gone", async () => {
    const key = {};
    const seen: (string[] | undefined)[] = [];
    const run = async (gone: string[] | undefined) => {
      seen.push(gone);
      return { kind: "parked" as const, reviewers: [{ kind: "parked", agent: "rv-o-r-7", alreadyGone: true }] };
    };

    await parkOnce(key, run);
    await parkOnce(key, run);

    expect(seen).toEqual([undefined, ["rv-o-r-7"]]);
  });
});

describe("the park Shepherd's park step runs by default", () => {
  it("tells agent-chat to skip its fix-round callback, since the caller is Shepherd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-park-"));
    const bin = join(dir, "agent-chat");
    writeFileSync(bin, `#!/bin/sh\n: >"${dir}/argv"\nfor a in "$@"; do printf '%s\\0' "$a" >>"${dir}/argv"; done\necho "Parked $3."\n`);
    chmodSync(bin, 0o755);
    const [route] = parkRoutes({ store: storeWith({ implementer: "impl-a" }), now: () => 0, agentChatBin: bin, roster: createRosterReader(async () => []), exitNotice: undefined });
    const step = { runId: "run-1", workflowName: "w", stepId: "sh-park:x", iteration: 0, prompt: JSON.stringify(input), signal: new AbortController().signal, attempt: 1, requestKey: "k" };

    const outcome = await route!.runner.run(step);
    const argv = readFileSync(join(dir, "argv"), "utf8").split("\0").slice(0, -1);
    rmSync(dir, { recursive: true, force: true });

    expect(outcome.ok).toBe(true);
    expect(argv).toEqual(["agent", "park", "impl-a", "--no-fix-round-check"]);
  });
});
