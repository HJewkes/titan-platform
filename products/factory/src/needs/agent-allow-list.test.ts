import { describe, expect, it } from "vitest";
import { inventoryAllowList } from "./agent-allow-list.js";

const inventoryFetch = (initiatives: object[]): typeof fetch => async () =>
  new Response(JSON.stringify({ ok: true, data: { initiatives, human_only_known: true } }), { headers: { "content-type": "application/json" } });

describe("the agent allow list from inventory (TP-5556)", () => {
  it("names only initiatives inventory reports as not withheld from agents", async () => {
    const allowed = inventoryAllowList("http://127.0.0.1:1", inventoryFetch([
      { slug: "alpha", withheld_from_agents: false },
      { slug: "private-plans", withheld_from_agents: true },
    ]));

    expect([...(await allowed())]).toEqual(["alpha"]);
  });

  it("withholds a row an older daemon sends without the field", async () => {
    const allowed = inventoryAllowList("http://127.0.0.1:1", inventoryFetch([{ slug: "kiln-tools", human_only: false }]));

    expect([...(await allowed())]).toEqual([]);
  });
});
