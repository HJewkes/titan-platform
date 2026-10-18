import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, successEnvelope } from "@titan-design/registry";
import { activeWorkClient } from "./active-work.js";
import { brokerReader } from "./broker.js";
import { createConsoleRegistry } from "./registry.js";
import { shepherdReader } from "./shepherd.js";
import { closedPort, startFakeDaemon, type FakeDaemon, type RpcAnswer } from "./test-support.js";

/** Shaped like a live `shepherd.list` row on basement (2026-10-12), one field per kind of value. */
function watchRow(pr: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repo: "hjewkes/royal_road_player",
    pr,
    branch: "agent-chat/ac-a-46-a-47-dates-years",
    runId: `bd9abc03-0000-4000-8000-${String(pr).padStart(12, "0")}`,
    task: "audiobook/A-46",
    phase: "awaiting-approval",
    headSha: "3adebe00282b176fb1dea223f5688d3cfa6ea0ae",
    phaseSince: "2026-10-11T19:27:22.411Z",
    nextAction: "owner: resolve sh-sent-back",
    pendingGate: { gateId: "bd9abc03/sh-sent-back:1", stepId: "sh-sent-back", since: "2026-10-08T14:24:41.774Z" },
    held: null,
    stalled: null,
    outcome: null,
    stage: { name: "hold", minutes: 1633 },
    ...extra,
  };
}

let factory: FakeDaemon | undefined;
afterEach(async () => {
  await factory?.close();
  factory = undefined;
});

async function serve(rpc: RpcAnswer): Promise<number> {
  factory = await startFakeDaemon({ ok: true }, rpc);
  return factory.port;
}

/** The fake daemon hides request headers, so the header test records them on a server of its own. */
async function recordHeaders(seen: IncomingHttpHeaders[]): Promise<number> {
  const server: Server = createServer((req, res) => {
    seen.push(req.headers);
    req.resume().on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(successEnvelope([])));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("header recorder bound no TCP port");
  factory = { port: address.port, close: () => new Promise((resolve) => server.close(() => resolve())) };
  return factory.port;
}

describe("shepherd reader", () => {
  it("returns the watch rows for the state asked, keeping fields the console does not pin", async () => {
    const asked: unknown[] = [];
    const port = await serve((command, args) => {
      asked.push({ command, args });
      return [watchRow(21, { reviewer: "rv-21" })];
    });

    const rows = await shepherdReader(port).list("finished");

    expect(asked).toEqual([{ command: "shepherd.list", args: { state: "finished" } }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pr: 21, reviewer: "rv-21", stage: { name: "hold", minutes: 1633 } });
  });

  it("returns a timeline with entries of any kind, and the waiting gates", async () => {
    const gate = { gateId: "g/approve-merge", stepId: "approve-merge", repo: "hjewkes/titan-design", pr: 794, head: "45e81c1", task: "titan-design/TD-759", since: "2026-10-09T15:20:51.359Z", ageHours: 79.3, headIsCurrent: true, held: null };
    const port = await serve((command) => {
      if (command === "shepherd.timeline") return { row: watchRow(21), entries: [{ kind: "brand-new-kind", at: "2026-10-12T00:00:00Z" }] };
      if (command === "shepherd.waiting") return { owner: [gate], seat: [] };
      throw new Error(`unexpected ${command}`);
    });
    const reader = shepherdReader(port);

    const timeline = await reader.timeline("hjewkes/royal_road_player", 21);
    const waiting = await reader.waiting();

    expect(timeline.entries).toEqual([{ kind: "brand-new-kind", at: "2026-10-12T00:00:00Z" }]);
    expect(waiting.owner[0]).toMatchObject({ gateId: "g/approve-merge", headIsCurrent: true });
  });

  it("refuses a row missing its runId as schema drift", async () => {
    const row = watchRow(21);
    delete row.runId;
    const port = await serve(() => [row]);

    await expect(shepherdReader(port).list("active")).rejects.toMatchObject({ message: "factory shepherd.list answered an unexpected shape", code: EXIT.SOFTWARE });
  });

  it("calls the factory as loopback with the client header, never forwarding a cookie or authorization", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const port = await recordHeaders(seen);

    await shepherdReader(port).list("active");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.host).toBe(`127.0.0.1:${port}`);
    expect(seen[0]?.["x-titan-client"]).toBeTruthy();
    expect(seen[0]?.cookie).toBeUndefined();
    expect(seen[0]?.authorization).toBeUndefined();
  });

  it("rejects with a sysexits code when the factory is down, never an empty list", async () => {
    await expect(shepherdReader(await closedPort()).list("active")).rejects.toMatchObject({ code: EXIT.UNAVAILABLE });
  });

  it("carries the factory's own error code for an unknown PR", async () => {
    const port = await serve(() => {
      throw new Error("gh: Not Found (HTTP 404)");
    });

    await expect(shepherdReader(port).timeline("hjewkes/nope", 1)).rejects.toMatchObject({ message: "factory shepherd.timeline: gh: Not Found (HTTP 404)", code: EXIT.USAGE });
  });

  it("releases one hold class at the confirmed head as the named actor, and carries Shepherd's refusal code", async () => {
    const asked: unknown[] = [];
    const release = { repo: "example/repo", pr: 7, head: "1234567890abcdef1234567890abcdef12345678", holdClass: "g10-review", actor: "owner-remote:titan-console action:0" };
    const port = await serve((command, args) => {
      asked.push({ command, args });
      if (asked.length > 1) throw Object.assign(new Error("example/repo#7 is not held, so there is nothing to release"), { code: EXIT.DATAERR });
      return { runId: "run-7", held: null };
    });
    const reader = shepherdReader(port);

    const after = await reader.release(release);
    const again = reader.release(release);

    expect(asked[0]).toEqual({ command: "shepherd.release", args: release });
    expect(after).toEqual({ runId: "run-7", held: null });
    await expect(again).rejects.toMatchObject({ message: "factory shepherd.release: example/repo#7 is not held, so there is nothing to release", code: EXIT.DATAERR });
  });
});

describe("the console's shepherd commands", () => {
  it("serves the three reads and no Shepherd write", () => {
    const registry = createConsoleRegistry({
      upstreams: [],
      agents: { broker: brokerReader({ port: 1, tokenPath: "/nonexistent/ui.token" }), eventsDbPath: "/nonexistent/events.db", seatPrefixes: [] },
      sessions: { graphPath: "/nonexistent/graph.sqlite3" },
      activeWork: activeWorkClient(1),
      inbox: { dir: "/nonexistent/inbox" },
      rounds: { dir: "/nonexistent/rounds" },
      shepherd: shepherdReader(1),
    });

    expect(["shepherd.list", "shepherd.timeline", "shepherd.waiting"].map((name) => registry.get(name)?.name)).toEqual(["shepherd.list", "shepherd.timeline", "shepherd.waiting"]);
    expect(["shepherd.merge", "shepherd.hold", "shepherd.release", "shepherd.register"].filter((name) => registry.get(name) !== undefined)).toEqual([]);
  });
});
