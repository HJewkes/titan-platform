import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { EXIT, successEnvelope } from "@titan-design/registry";
import { factoryNeeds } from "./factory.js";
import { closedPort, startFakeDaemon, type FakeDaemon } from "./test-support.js";

/** Shaped like the live #794 gate the factory serves on basement, trimmed to what the schema needs. */
function gateItem(id: string): Record<string, unknown> {
  return {
    id,
    sources: [{ system: "hitl", ref: id.replace(/^gate:/, "") }],
    kind: "approve",
    door: "one-way",
    summary: "Merge hjewkes/titan-design#794 at 45e81c1?",
    context: "CI is green.",
    keys: [id],
    personal: false,
    lens: "blocking-merge",
    unblocks: [],
    openedAt: "2026-10-09T15:20:51.359Z",
    status: "open",
  };
}

let factory: FakeDaemon | undefined;
afterEach(async () => {
  await factory?.close();
  factory = undefined;
});

async function serveNeeds(data: unknown): Promise<number> {
  factory = await startFakeDaemon({ ok: true }, (command) => {
    if (command !== "needs.list") throw new Error(`unexpected ${command}`);
    return data;
  });
  return factory.port;
}

/** The fake daemon hides request headers, so the header test records them on a server of its own. */
async function recordHeaders(seen: IncomingHttpHeaders[]): Promise<number> {
  const server: Server = createServer((req, res) => {
    seen.push(req.headers);
    req.resume().on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(successEnvelope({ items: [], gaps: [] })));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  factory = { port: (server.address() as AddressInfo).port, close: () => new Promise((resolve) => server.close(() => resolve())) };
  return factory.port;
}

describe("factory needs client", () => {
  it("returns every valid item with the factory's own gaps", async () => {
    const port = await serveNeeds({ items: [gateItem("gate:a/approve-merge"), gateItem("gate:b/approve-merge")], gaps: ["morning: x"] });

    const list = await factoryNeeds(port).list();

    expect(list.items.map((item) => item.id)).toEqual(["gate:a/approve-merge", "gate:b/approve-merge"]);
    expect(list.gaps).toEqual(["morning: x"]);
  });

  it("turns one invalid item into a gap that names it and keeps the rest", async () => {
    const port = await serveNeeds({ items: [gateItem("gate:a/approve-merge"), { ...gateItem("gate:bad/approve-merge"), kind: "nonsense" }, 7], gaps: [] });

    const list = await factoryNeeds(port).list();

    expect(list.items.map((item) => item.id)).toEqual(["gate:a/approve-merge"]);
    expect(list.gaps).toEqual(["factory item gate:bad/approve-merge: invalid", "factory item #2: invalid"]);
  });

  it("sends the client header the factory's CSRF guard needs, and no token", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const port = await recordHeaders(seen);

    await factoryNeeds(port).list();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.["x-titan-client"]).toBeTruthy();
    expect(seen[0]?.authorization).toBeUndefined();
  });

  it("rejects with a sysexits code when the factory is down, never an empty list", async () => {
    await expect(factoryNeeds(await closedPort()).list()).rejects.toMatchObject({ code: EXIT.UNAVAILABLE });
  });

  it("rejects an answer of another shape as schema drift", async () => {
    const port = await serveNeeds({ needs: [] });

    await expect(factoryNeeds(port).list()).rejects.toMatchObject({ message: "factory needs.list answered an unexpected shape", code: EXIT.SOFTWARE });
  });
});
