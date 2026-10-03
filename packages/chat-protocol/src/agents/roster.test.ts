import { describe, expect, it } from "vitest";
import { foldRoster, seatOf, type RosterInput } from "./roster.js";
import { agentRosterSnapshot, type BrokerEvent, type BrokerSession } from "./types.js";

const NOW = 100_000;

function session(overrides: Partial<BrokerSession> & Pick<BrokerSession, "name">): BrokerSession {
  return { workingOn: "", cwd: "/work/repo", status: "working", idleMs: 1_000, registeredAt: 50_000, ...overrides };
}

function event(overrides: Partial<BrokerEvent> & Pick<BrokerEvent, "msgId" | "kind" | "from">): BrokerEvent {
  return { text: "", at: 10_000, meta: {}, ...overrides };
}

function spawned(spawner: string, name: string, meta: Record<string, string> = {}, at = 10_000): BrokerEvent {
  return event({ msgId: `agent-${name}`, kind: "agent_spawned", from: spawner, at, text: `Do ${name}\nmore`, meta: { target: name, ...meta } });
}

function roster(overrides: Partial<RosterInput>) {
  return foldRoster({ sessions: [], brokerUptimeMs: 60_000, events: [], historyLimit: 1000, now: NOW, ...overrides });
}

describe("foldRoster", () => {
  it("keys a live session by its Claude Code session id when it has one", () => {
    const [entry] = roster({ sessions: [session({ name: "w1", observed: { claudeSessionId: "sess-1" } })] }).agents;
    expect(entry).toMatchObject({ id: "sess-1", idSource: "claudeSessionId", state: "working", stateSource: "presence" });
  });

  it("falls back to name@registeredAt for a session Claude Code did not start", () => {
    const [entry] = roster({ sessions: [session({ name: "raw", registeredAt: 42 })] }).agents;
    expect(entry).toMatchObject({ id: "raw@42", idSource: "nameAtRegisteredAt", origin: "unknown", spawnedBy: null });
  });

  it("joins a live session to its spawn row for surface, profile, spawner and seat", () => {
    const snapshot = roster({
      sessions: [session({ name: "tpc-impl", workingOn: "XY-12: build it" })],
      events: [spawned("tpc", "tpc-impl", { surface: "headless", profile: "implementer" })],
      seatPrefixes: [{ seat: "titan-coord", prefix: "tpc" }],
    });
    expect(snapshot.agents[0]).toMatchObject({
      agentId: "agent-tpc-impl",
      origin: "spawned",
      spawnedBy: "tpc",
      surface: "headless",
      profile: "implementer",
      seat: "titan-coord",
      taskId: "XY-12",
    });
  });

  it("reads exited, failed and retired agents from history when presence is gone", () => {
    const events = [
      spawned("coord", "done"),
      event({ msgId: "e1", kind: "agent_exited", from: "done", at: 11_000, meta: { cost_usd: "1.25" } }),
      spawned("coord", "broken"),
      event({ msgId: "e2", kind: "agent_exited", from: "broken", at: 12_000, meta: { failed: "true" } }),
      spawned("coord", "gone"),
      event({ msgId: "e3", kind: "agent_retired", from: "human", at: 13_000, meta: { target: "gone" } }),
    ];
    const states = Object.fromEntries(roster({ events }).agents.map((a) => [a.name, [a.state, a.stateSource]]));
    expect(states).toEqual({ done: ["exited", "history"], broken: ["failed", "history"], gone: ["retired", "history"] });
  });

  it("calls an attached agent with no presence detached", () => {
    const events = [spawned("coord", "w"), event({ msgId: "e1", kind: "agent_attached", from: "w", at: 11_000 })];
    expect(roster({ events }).agents[0]?.state).toBe("detached");
  });

  it("gives a history-only row nullable presence fields and the brief's first line", () => {
    const [entry] = roster({ events: [spawned("coord", "w", { session_id: "sess-9" })] }).agents;
    expect(entry).toMatchObject({ id: "sess-9", workingOn: "Do w", cwd: null, idleMs: null, dnd: false, tags: [] });
  });

  it("prefers a session-analytics price over the exit report's cost", () => {
    const events = [
      spawned("coord", "w", { session_id: "sess-2" }),
      event({ msgId: "e1", kind: "agent_exited", from: "w", at: 11_000, meta: { cost_usd: "0.5" } }),
    ];
    expect(roster({ events }).agents[0]).toMatchObject({ costUsd: 0.5, costSource: "exit-report" });
    const priced = roster({ events, costOf: (id) => (id === "sess-2" ? 3 : undefined) }).agents[0];
    expect(priced).toMatchObject({ costUsd: 3, costSource: "session-analytics" });
  });

  it("flags a broker that restarted moments ago as reconnecting", () => {
    expect(roster({ brokerUptimeMs: 3_000 }).reconnecting).toBe(true);
    expect(roster({ brokerUptimeMs: 60_000 }).reconnecting).toBe(false);
  });

  it("carries tags, dnd and provisional from presence", () => {
    const [entry] = roster({
      sessions: [session({ name: "w", dnd: true, provisional: true, tags: [{ tag: "owner:src" }] })],
    }).agents;
    expect(entry).toMatchObject({ dnd: true, provisional: true, tags: ["owner:src"] });
  });

  it("produces a snapshot the wire schema accepts", () => {
    const snapshot = roster({ sessions: [session({ name: "w" })], events: [spawned("coord", "x")] });
    expect(agentRosterSnapshot.safeParse(snapshot).success).toBe(true);
  });
});

describe("seatOf", () => {
  it("takes the longest prefix that matches a whole name segment", () => {
    const prefixes = [
      { seat: "outer", prefix: "tp" },
      { seat: "inner", prefix: "tpc" },
    ];
    expect(seatOf("tpc-x", prefixes)).toBe("inner");
    expect(seatOf("tp-x", prefixes)).toBe("outer");
    expect(seatOf("tpcx", prefixes)).toBeNull();
  });
});
