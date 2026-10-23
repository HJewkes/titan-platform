import type { AgentRow } from "@titan-design/agent-dispatch";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { REPO } from "../test-support/land.js";
import { REPO_SEAT, agentRow, digestSweep, liveRow, redRun, retiredRow } from "../test-support/registrant-routing.js";
import type { NoticeFallbacks } from "./exit-notice.js";

const FALLBACKS: NoticeFallbacks = { redSeat: { repos: { [REPO.toUpperCase()]: "red-coord" } }, hubSeat: "hub-coord" };
const WORKER = "worker-a";
const retiredBy = (name: string, spawnedBy: string): AgentRow => ({ ...retiredRow(name), spawnedBy });
const liveBy = (name: string, spawnedBy: string): AgentRow => ({ ...liveRow(name), spawnedBy });

/** The repo's seat is retired in every case, so a digest that is not the chain's goes to a fallback. */
async function digestSeats(chain: readonly AgentRow[], fallbacksLive: readonly string[] = ["red-coord", "hub-coord"]): Promise<string[]> {
  const roster = [...chain, retiredRow(REPO_SEAT), ...fallbacksLive.map(liveRow)];
  const world = await redRun({ registrant: WORKER }, roster, FALLBACKS);
  return (await digestSweep(world, roster, FALLBACKS)).told;
}

describe("a dead registrant's seat digest goes to the live seat that spawned it (TP-4061)", () => {
  it("a dead spawned agent with a live spawner has its digest sent to the spawner", async () => {
    expect(await digestSeats([agentRow(WORKER, "spawn-coord"), liveRow("spawn-coord")])).toEqual(["spawn-coord"]);
  });

  it("a dead agent whose spawner is dead too has its digest sent to the live grand-spawner", async () => {
    expect(await digestSeats([agentRow(WORKER, "mid-coord"), retiredBy("mid-coord", "top-coord"), liveRow("top-coord")])).toEqual(["top-coord"]);
  });

  it("a wholly dead spawner chain sends the digest to the repo's red seat", async () => {
    expect(await digestSeats([agentRow(WORKER, "mid-coord"), retiredBy("mid-coord", "top-coord"), retiredRow("top-coord")])).toEqual(["red-coord"]);
  });

  it("with no live seat in the chain and no live red seat, the hub seat hears it", async () => {
    expect(await digestSeats([agentRow(WORKER, "mid-coord"), retiredRow("mid-coord")], ["hub-coord"])).toEqual(["hub-coord"]);
  });

  it("a live registrant keeps its own digest, whoever spawned it", async () => {
    expect(await digestSeats([liveBy(WORKER, "spawn-coord"), liveRow("spawn-coord")])).toEqual([WORKER]);
  });

  it("an unreadable roster routes the digest by repo seat, as before, and logs why", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onTestFinished(() => logged.mockRestore());
    const roster = [agentRow(WORKER, "spawn-coord"), liveRow("spawn-coord"), retiredRow(REPO_SEAT), liveRow("hub-coord")];
    const world = await redRun({ registrant: WORKER }, roster, FALLBACKS);

    const sweep = await digestSweep(world, roster, FALLBACKS, true);

    expect(sweep.told).toEqual([REPO_SEAT]);
    expect(logged).toHaveBeenCalledWith(expect.stringMatching(/seat digests go by repo seat, the roster could not be read: broker down/));
  });
});
