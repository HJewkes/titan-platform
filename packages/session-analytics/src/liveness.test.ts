import { describe, expect, it } from "vitest";
import { parseBrokerLog } from "./liveness-broker.js";
import type { SpawnRecord } from "./liveness-exits.js";
import type { LastEventRecord } from "./liveness-prompts.js";
import { livenessReport, livenessSchema, renderLivenessText } from "./liveness.js";

const at = (hhmmss: string) => `2026-09-10T${hhmmss}.000Z`;
const log = (time: string, event: string, fields: Record<string, unknown> = {}) => JSON.stringify({ ts: at(time), event, ...fields });

/** Line numbers are the array index plus one; the report cites them. */
const BROKER = [
  log("09:00:00", "broker_started"),
  log("10:00:00", "registered", { name: "seat-a" }),
  log("10:00:00", "registered", { name: "seat-b" }),
  log("10:10:00", "deregistered", { name: "seat-a", reason: "connection closed" }),
  log("10:15:00", "route", { kind: "message", from: "impl-1", to: "seat-a", delivered: false, recipients: [] }),
  log("10:16:00", "route", { kind: "message", from: "impl-1", to: "seat-a, seat-b", delivered: true, recipients: ["seat-b"] }),
  log("10:20:00", "route", { kind: "answer", from: "human", to: "seat-a", delivered: false }),
  log("10:40:00", "registered", { name: "seat-a" }),
  log("11:00:00", "teleport_started", { name: "seat-b", from: "b1", to: "b2" }),
  log("11:00:30", "deregistered", { name: "seat-b", reason: "connection closed" }),
  log("11:00:40", "registered", { name: "seat-b" }),
  log("11:30:00", "teleport_started", { name: "seat-b", from: "b2", to: "b3" }),
  log("11:30:30", "deregistered", { name: "seat-b", reason: "connection closed" }),
  log("11:31:00", "teleport_failed", { name: "seat-b", from: "b2", to: "b3" }),
  log("11:45:00", "registered", { name: "seat-b" }),
  log("11:50:00", "route", { kind: "broadcast", from: "seat-a", to: "*", delivered: true, recipients: [] }),
  log("12:00:00", "deregistered", { name: "impl-1", reason: "connection closed" }),
  log("12:00:00", "deregistered", { name: "impl-2", reason: "connection closed" }),
  log("12:01:00", "unreported-exit", { agentId: "a1", name: "impl-1", spawner: "seat-a", lastAction: "chat_send" }),
  log("12:02:00", "unreported-exit", { agentId: "a9", name: "rev-9", spawner: "seat-b", lastAction: "Bash(git)" }),
  "not json",
  log("12:05:00", "route", { kind: "message", from: "seat-a", to: "impl-2", delivered: false, recipients: [] }),
  log("13:30:00", "route", { kind: "message", from: "seat-a", to: "seat-b", delivered: false, recipients: [] }),
  log("10:25:00", "route", { kind: "message", from: "impl-1", to: "seat-a", delivered: false, held: "seat_dark" }),
  log("10:26:00", "route", { kind: "decided", from: "decider", to: "seat-a", delivered: false, provenance: "decided" }),
  log("10:27:00", "route", { kind: "message", from: "impl-1", to: "tag seat-a", delivered: false, recipients: [] }),
  log("10:28:00", "route", { kind: "message", from: "impl-1", to: "tag reviewers", delivered: true, recipients: ["seat-b"] }),
];

const SPAWNS: SpawnRecord[] = [{ eventId: 7, agentId: "a1", name: "impl-1", profile: "implementer" }];

const prompt = (actor: string, time: string, kind = "approval_request"): LastEventRecord => ({ eventId: actor.length * 10, at: at(time), actor, kind, tool: "Bash", resolutionEventId: null, endEventId: null });
const LAST_EVENTS = [prompt("rev-1", "12:30:00"), prompt("rev-22", "12:55:00"), prompt("impl-333", "12:00:00", "message"), { ...prompt("rev-4444", "12:00:00"), resolutionEventId: 99 }];

const AS_OF = at("13:00:00");

function report(extra: { window?: { since?: string; until?: string }; seats?: string[] } = {}) {
  return livenessReport({ broker: parseBrokerLog(BROKER), spawns: SPAWNS, lastEvents: LAST_EVENTS, asOf: AS_OF, ...extra });
}

describe("parseBrokerLog", () => {
  it("numbers entries by file line, counting a line it skips", () => {
    const entries = parseBrokerLog(BROKER);

    expect(entries).toHaveLength(BROKER.length - 1);
    expect(entries.map((e) => e.line)).not.toContain(21);
    expect(entries.at(-1)).toMatchObject({ line: BROKER.length, event: "route" });
  });
});

describe("livenessReport", () => {
  it("reports seats dark over 5 min with and without a teleport, citing their lines", () => {
    const { darkSeats } = report();

    expect([darkSeats.withTeleport, darkSeats.withoutTeleport]).toEqual([1, 2]);
    expect(darkSeats.rows).toEqual([
      { seat: "seat-a", from: at("10:10:00"), to: at("10:40:00"), minutes: 30, teleport: false, failedRoutes: 1, partialRoutes: 1, queuedRoutes: 3, lines: [4, 8], routeLines: [5, 6, 7, 24, 25] },
      { seat: "seat-b", from: at("11:30:30"), to: at("11:45:00"), minutes: 14.5, teleport: true, failedRoutes: 0, partialRoutes: 0, queuedRoutes: 0, lines: [13, 15, 12, 14], routeLines: [] },
      { seat: "impl-2", from: at("12:00:00"), to: null, minutes: 60, teleport: false, failedRoutes: 1, partialRoutes: 0, queuedRoutes: 0, lines: [18], routeLines: [22] },
    ]);
  });

  it("leaves out an agent that left and was never addressed again", () => {
    expect(report().darkSeats.rows.map((r) => r.seat)).not.toContain("impl-1");
  });

  it("counts dropped routes apart from partial deliveries and held or inbox-queued ones, skipping broadcasts and tag sends", () => {
    const { routeFailures } = report();

    expect(routeFailures).toMatchObject({ failed: 2, partial: 1, queued: 3 });
    expect(routeFailures.rows).toEqual([
      { recipient: "seat-a", failed: 1, partial: 1, queued: 3, first: at("10:15:00"), last: at("10:26:00"), lines: [5, 6, 7, 24, 25] },
      { recipient: "impl-2", failed: 1, partial: 0, queued: 0, first: at("12:05:00"), last: at("12:05:00"), lines: [22] },
    ]);
  });

  it("groups unreported exits by the profile they were spawned with", () => {
    const { unreportedExits } = report();

    expect(unreportedExits.total).toBe(2);
    expect(unreportedExits.rows.map((r) => [r.profile, r.exits.map((e) => [e.name, e.line, e.spawnEventId])])).toEqual([
      ["implementer", [["impl-1", 19, 7]]],
      ["unknown", [["rev-9", 20, null]]],
    ]);
  });

  it("lists agents whose last event is a permission prompt over 10 min old, resolved ones apart", () => {
    const { stalePrompts } = report();

    expect(stalePrompts.rows).toEqual([{ agent: "rev-1", at: at("12:30:00"), ageMin: 30, tool: "Bash", eventId: 50, resolutionEventId: null }]);
    expect(stalePrompts.resolvedRows.map((r) => [r.agent, r.resolutionEventId])).toEqual([["rev-4444", 99]]);
  });

  it("keeps a prompt raised before --since that is still unanswered at asOf", () => {
    expect(report({ window: { since: at("12:45:00") } }).stalePrompts.rows.map((r) => r.agent)).toEqual(["rev-1"]);
  });

  it("skips a gap where the agent exited before registering again, as a resume rather than a dark seat", () => {
    const broker = parseBrokerLog([
      log("10:00:00", "deregistered", { name: "rev-5" }),
      log("10:00:01", "agent_exited", { agentId: "a5", name: "rev-5", code: 0 }),
      log("10:20:00", "registered", { name: "rev-5" }),
      log("11:00:00", "agent_exited", { agentId: "a6", name: "rev-6", code: 0 }),
      log("11:00:01", "deregistered", { name: "rev-6" }),
      log("11:10:00", "route", { kind: "message", from: "seat-a", to: "rev-6", delivered: false, recipients: [] }),
      log("12:00:00", "deregistered", { name: "rev-7" }),
      log("12:20:00", "registered", { name: "rev-7" }),
    ]);

    expect(livenessReport({ broker, spawns: [], lastEvents: [], asOf: AS_OF }).darkSeats.rows.map((r) => r.seat)).toEqual(["rev-7"]);
  });

  it("keeps a teleport gap whose old process exited", () => {
    const broker = parseBrokerLog([
      log("10:00:00", "teleport_started", { name: "seat-d" }),
      log("10:00:30", "deregistered", { name: "seat-d" }),
      log("10:00:31", "agent_exited", { agentId: "d1", name: "seat-d", code: 0 }),
      log("10:20:00", "registered", { name: "seat-d" }),
    ]);

    expect(livenessReport({ broker, spawns: [], lastEvents: [], asOf: AS_OF }).darkSeats.rows).toMatchObject([{ seat: "seat-d", teleport: true }]);
  });

  it("skips a prompt from an agent that exited or retired since, or never re-registered after a broker restart", () => {
    const broker = parseBrokerLog([log("12:40:00", "broker_started"), log("12:40:05", "registered", { name: "rev-1" })]);
    const lastEvents = [prompt("rev-1", "12:30:00"), prompt("rev-22", "12:35:00"), { ...prompt("rev-333", "12:42:00"), endEventId: 120 }, prompt("rev-4444", "12:45:00")];

    const { stalePrompts } = livenessReport({ broker, spawns: [], lastEvents, asOf: AS_OF });

    expect(stalePrompts.rows.map((r) => r.agent)).toEqual(["rev-1", "rev-4444"]);
  });

  it("marks a gap after an aborted teleport as a teleport gap", () => {
    const broker = parseBrokerLog([log("10:00:00", "deregistered", { name: "seat-c" }), log("10:00:05", "teleport_aborted", { name: "seat-c" }), log("10:20:00", "registered", { name: "seat-c" })]);

    expect(livenessReport({ broker, spawns: [], lastEvents: [], asOf: AS_OF }).darkSeats.rows).toMatchObject([{ seat: "seat-c", teleport: true }]);
  });

  it("keeps findings that start inside the window and concern the named seats", () => {
    const windowed = report({ window: { since: at("11:00:00") } });
    const named = report({ seats: ["seat-a"] });

    expect(windowed.darkSeats.rows.map((r) => r.seat)).toEqual(["seat-b", "impl-2"]);
    expect(named.darkSeats.rows.map((r) => r.seat)).toEqual(["seat-a"]);
    expect(named.unreportedExits.rows.map((r) => r.profile)).toEqual(["implementer"]);
    expect(named.stalePrompts.rows).toEqual([]);
  });

  it("validates against its schema and names each table's JSON field and cited lines in text", () => {
    const data = report();
    const text = renderLivenessText(data);

    expect(livenessSchema.safeParse(data).success).toBe(true);
    for (const field of ["darkSeats.rows[]", "routeFailures.rows[]", "unreportedExits.rows[].exits[]", "stalePrompts.rows[]", "stalePrompts.resolvedRows[]"]) expect(text).toContain(`[${field}]`);
    expect(text).toContain("broker.log:4,broker.log:8,broker.log:5,broker.log:6 +3");
    expect(text).toContain("events#7");
  });
});
