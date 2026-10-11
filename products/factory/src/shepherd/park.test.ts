import { DispatchError } from "@titan-design/agent-dispatch";
import { describe, expect, it } from "vitest";
import type { ExitNoticePorts } from "./exit-notice.js";
import { parkImplementer, parkRoutes, parkStep, rearmRecorded, type ParkPort } from "./park.js";
import { liveRetry, type LiveRetryDeps } from "./park-retry.js";
import type { ShepherdStoreRef } from "./store.js";

interface Registered {
  implementer?: string;
  branch?: string | null;
  seat?: string;
  successors?: string[];
}

const storeWith = ({ implementer, branch = null, seat = "demo-seat", successors = [] }: Registered = {}) =>
  ({
    get: () => ({
      byRun: () => (implementer ? { implementer, branch, repo: "o/r", pr: 7, runId: "run-1", policy: { seat } } : undefined),
      authorsOf: () => successors.map((name) => ({ name, role: "successor" })),
    }),
  }) as unknown as ShepherdStoreRef;
const input = { runId: "run-1", headSha: "a".repeat(40) };

const refusing =
  (reasons: Record<string, string>, asked: string[] = []): ParkPort =>
  (name) => {
    asked.push(name);
    const reason = reasons[name];
    if (reason === undefined) return { lines: [`Parked ${name}.`] };
    throw new DispatchError(`agent-chat refused agent park: Not parked: ${reason}`);
  };

function noticePorts(hubSeat?: string): ExitNoticePorts & { sent: [string, string][] } {
  const sent: [string, string][] = [];
  return { sent, seatFor: () => undefined, hubSeat: () => hubSeat, lastReport: async () => undefined, send: async (seat, text) => void sent.push([seat, text]) };
}

const LIVE = (name: string) => `${name} is live; park takes only an agent whose process has exited or that this broker no longer tracks`;

describe("parkImplementer", () => {
  it("skips without asking the broker when no registration names an implementer", () => {
    const asked: string[] = [];
    const park: ParkPort = (name) => (asked.push(name), { lines: [] });

    const outcome = parkImplementer(storeWith(), park, input);

    expect(outcome).toEqual({ kind: "skipped", reason: "no registration names the implementer" });
    expect(asked).toEqual([]);
  });

  it("answers a thrown non-Error as not parked rather than failing the step", () => {
    const park: ParkPort = () => {
      throw "socket closed";
    };

    expect(parkImplementer(storeWith({ implementer: "impl-a" }), park, input)).toEqual({ kind: "not-parked", agent: "impl-a", reason: "socket closed", brokerDown: false });
  });

  it("counts a tree that is already off disk as parked", () => {
    const park = refusing({ "impl-a": "/tmp/tree is not on disk; nothing to park" });

    const outcome = parkImplementer(storeWith({ implementer: "impl-a" }), park, input);

    expect(outcome).toMatchObject({ kind: "parked", agent: "impl-a", alreadyGone: true });
  });

  it("parks the successor and the agent its agent-chat branch was allocated to when the registered name is unknown", () => {
    const asked: string[] = [];
    const park = refusing({ "seat-label": 'no agent named "seat-label"' }, asked);

    const outcome = parkImplementer(storeWith({ implementer: "seat-label", branch: "agent-chat/impl-b", successors: ["impl-a-s1"] }), park, input);

    expect(asked).toEqual(["impl-a-s1", "seat-label", "impl-b"]);
    expect(outcome).toEqual({ kind: "parked", agent: "impl-a-s1, impl-b", lines: ["Parked impl-a-s1.", "Parked impl-b."] });
  });
});

describe("parkStep", () => {
  it("tells the run's seat in one line why a tree was not parked", async () => {
    const notice = noticePorts("hub");
    const park = refusing({ "impl-a": "uncommitted or untracked changes in /tmp/tree" });

    const outcome = await parkStep(storeWith({ implementer: "impl-a" }), { park, notice }, input);

    expect(notice.sent).toEqual([["demo-seat", "Shepherd: o/r#7: impl-a's worktree was not parked: agent-chat refused agent park: Not parked: uncommitted or untracked changes in /tmp/tree"]]);
    expect(outcome).toMatchObject({ kind: "not-parked", notice: "sent to demo-seat" });
  });

  it("falls back to the hub seat when the run's policy names no seat", async () => {
    const notice = noticePorts("hub");
    const park = refusing({ "impl-a": "uncommitted or untracked changes in /tmp/tree" });

    await parkStep(storeWith({ implementer: "impl-a", seat: "none" }), { park, notice }, input);

    expect(notice.sent.map(([seat]) => seat)).toEqual(["hub"]);
  });

  it("holds a live agent's refusal for a retry at its exit instead of telling the seat", async () => {
    const notice = noticePorts("hub");
    const armed: string[] = [];
    const retry = { arm: (agent: string) => void armed.push(agent) };

    const outcome = await parkStep(storeWith({ implementer: "impl-a" }), { park: refusing({ "impl-a": LIVE("impl-a") }), notice, retry }, input);

    expect(outcome).toMatchObject({ kind: "not-parked", retry: "at-exit" });
    expect(armed).toEqual(["impl-a"]);
    expect(notice.sent).toEqual([]);
  });

  it("tells the seat when the retry at exit still leaves the tree standing", async () => {
    const notice = noticePorts();
    let settling: Promise<void> | undefined;
    const retry = { arm: (agent: string, settle: (settled: { agent: string; parked: boolean; detail: string }) => Promise<void>) => (settling = settle({ agent, parked: false, detail: "still dirty" })) };

    await parkStep(storeWith({ implementer: "impl-a" }), { park: refusing({ "impl-a": LIVE("impl-a") }), notice, retry }, input);
    await settling;

    expect(notice.sent).toEqual([["demo-seat", "Shepherd: o/r#7: impl-a's worktree was not parked: still dirty"]]);
  });
});

describe("liveRetry", () => {
  function retryWorld(presences: string[], attempts: ReturnType<LiveRetryDeps["attempt"]>[]) {
    const tried: string[] = [];
    let clock = 0;
    const deps: LiveRetryDeps = {
      attempt: (name) => (tried.push(name), attempts.shift() ?? { done: true, parked: true, detail: "parked" }),
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
    expect(settled).toEqual([{ agent: "impl-a", parked: true, detail: "parked" }]);
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
    parkRoutes({ store: storeWith({ implementer: "impl-a" }), now: () => 0, agentChatBin: "agent-chat" }, refusing({}), { arm: (agent) => void armed.push(agent) });
    const recorded = { kind: "not-parked", agent: "impl-a", reason: LIVE("impl-a"), brokerDown: false, retry: "at-exit" };

    rearmRecorded("run-1", recorded);

    expect(armed).toEqual(["impl-a"]);
  });
});
