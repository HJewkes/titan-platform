import { describe, expect, it } from "vitest";
import { REPO, gateId, gateOpened } from "../test-support/land.js";
import { BOOK, REPO_SEAT, digestSweep, liveRow, redRun, retiredRow, startRed } from "../test-support/registrant-routing.js";
import type { NoticeFallbacks } from "./exit-notice.js";

describe("a seat digest for a seat with no live session goes where its notice goes (TP-4050)", () => {
  const FALLBACKS: NoticeFallbacks = { redSeat: { repos: { [REPO.toUpperCase()]: "red-coord" }, fallback: "red-fallback" }, hubSeat: "hub-coord" };

  it("a retired repo seat's digest goes to the repo's red seat", async () => {
    const roster = [retiredRow(REPO_SEAT), liveRow("red-coord"), liveRow("hub-coord")];
    const world = await redRun({}, roster, FALLBACKS);

    const sweep = await digestSweep(world, roster, FALLBACKS);

    expect(sweep).toMatchObject({ told: ["red-coord"], sent: ["red-coord"], failed: [] });
  });

  it("skips fallbacks with no live session, down to the hub seat", async () => {
    const roster = [retiredRow(REPO_SEAT), retiredRow("red-coord"), liveRow("hub-coord")];
    const world = await redRun({}, roster, FALLBACKS);

    expect((await digestSweep(world, roster, FALLBACKS)).told).toEqual(["hub-coord"]);
  });

  it("sends nothing and records why when neither the seat nor any fallback holds a live session", async () => {
    const roster = [retiredRow(REPO_SEAT)];
    const world = startRed({}, roster, BOOK, FALLBACKS);
    await gateOpened(world.host, gateId(world.runId, "ci-failed"));

    const sweep = await digestSweep(world, roster, FALLBACKS);

    expect(sweep).toMatchObject({ told: [], sent: [], failed: [{ seat: REPO_SEAT, cause: `${REPO_SEAT} holds no live session and no fallback seat does` }] });
  });

  it("keeps the repo's seat when the roster cannot be read, as for notices", async () => {
    const world = await redRun({});

    const sweep = await digestSweep(world, [retiredRow(REPO_SEAT), liveRow("hub-coord")], FALLBACKS, true);

    expect(sweep.told).toEqual([REPO_SEAT]);
  });
});
