import { describe, expect, it } from "vitest";
import { foldAgentGraph } from "./graph.js";
import { agentGraph, type AgentRosterEntry, type BrokerEvent } from "./types.js";

function event(overrides: Partial<BrokerEvent> & Pick<BrokerEvent, "msgId" | "kind" | "from">): BrokerEvent {
  return { text: "", at: 1_000, meta: {}, ...overrides };
}

const spawn = (parent: string, child: string, at = 1_000): BrokerEvent =>
  event({ msgId: `agent-${child}-${at}`, kind: "agent_spawned", from: parent, at, meta: { target: child } });

const send = (msgId: string, from: string, to: string, at = 2_000, kind = "message"): BrokerEvent =>
  event({ msgId, kind, from, at, meta: { target: to } });

const graph = (events: BrokerEvent[], roster?: AgentRosterEntry[]) =>
  foldAgentGraph({ events, historyLimit: 1000, now: 5_000, ...(roster ? { roster } : {}) });

describe("foldAgentGraph", () => {
  it("counts messages per ordered pair and points edges at node ids", () => {
    const result = graph([spawn("root", "a"), send("m1", "root", "a"), send("m2", "root", "a", 3_000), send("m3", "a", "root")]);
    const messages = result.edges.filter((edge) => edge.kind === "message");
    expect(messages).toEqual([
      { kind: "message", from: "agent-a-1000", to: "name:root", count: 1, lastAt: 2_000 },
      { kind: "message", from: "name:root", to: "agent-a-1000", count: 2, lastAt: 3_000 },
    ]);
  });

  it("counts a multicast row once per recipient and ignores broadcasts", () => {
    const result = graph([
      spawn("root", "a"),
      spawn("root", "b"),
      send("m1", "root", "a"),
      send("m1", "root", "b"),
      send("m1", "root", "a"),
      event({ msgId: "b1", kind: "broadcast", from: "root" }),
    ]);
    expect(result.edges.filter((edge) => edge.kind === "message").map((edge) => edge.count)).toEqual([1, 1]);
  });

  it("keeps the newest parent and a stable id when a name is respawned", () => {
    const result = graph([spawn("old", "w", 1_000), spawn("new", "w", 4_000)]);
    const node = result.nodes.find((n) => n.name === "w");
    expect(node).toMatchObject({ id: "agent-w-4000", parent: "new" });
    expect(result.edges.filter((edge) => edge.kind === "spawned")).toEqual([
      { kind: "spawned", from: "name:new", to: "agent-w-4000", count: 1, lastAt: 4_000 },
    ]);
  });

  it("uses the roster id for a node the roster knows", () => {
    const result = graph([spawn("root", "a")], [{ name: "a", id: "sess-a" } as AgentRosterEntry]);
    expect(result.nodes.find((n) => n.name === "a")).toMatchObject({ id: "sess-a", rosterId: "sess-a" });
  });

  it("orders nodes by depth, then row", () => {
    const result = graph([spawn("root", "b"), spawn("root", "a"), spawn("a", "a1")]);
    expect(result.nodes.map((n) => [n.name, n.depth])).toEqual([
      ["root", 0],
      ["a", 1],
      ["b", 1],
      ["a1", 2],
    ]);
  });

  it("reports the history window it saw and satisfies the wire schema", () => {
    const result = graph([spawn("root", "a", 700), send("m1", "root", "a", 900)]);
    expect(result.history).toEqual({ events: 2, limit: 1000, oldestAt: 700 });
    expect(agentGraph.safeParse(result).success).toBe(true);
  });
});
