import type { AgentRow } from "@titan-design/agent-dispatch";
import { describe, expect, it } from "vitest";
import { REPO, gateId, gateOpened } from "../test-support/land.js";
import { BOOK, REPO_SEAT, agentRow, digestSweep, liveRow, redRun, retiredRow, seatOf, startRed, type RedWorld } from "../test-support/registrant-routing.js";
import type { NoticeFallbacks } from "./exit-notice.js";
import type { SeatBook } from "./seats.js";

/** What the run's sh-seat-notice step recorded. */
function noticeRecord(world: RedWorld): unknown {
  const run = world.host.runtime.status(world.runId)!;
  const notice = Object.values(run.stepResults).find((result) => result.stepId.startsWith("sh-seat-notice"));
  return (notice?.data as { result?: unknown } | undefined)?.result;
}

async function digestSeats(world: RedWorld, roster?: readonly AgentRow[]): Promise<string[]> {
  return (await digestSweep(world, roster)).told;
}

describe("Shepherd's seat notice and digest follow the run's registrant, not the repo's seat (TP-3653)", () => {
  it("a run tp-operator registered sends its seat notice and its digest to tp-operator only", async () => {
    const world = await redRun({ registrant: "tp-operator" });

    expect(world.notices.told).toEqual(["tp-operator"]);
    expect(await digestSeats(world)).toEqual(["tp-operator"]);
  });

  it("a fixer that registered its own PR has its notices sent to the session that spawned it", async () => {
    const roster = [agentRow("impl-a", "tp-operator")];
    const world = await redRun({ registrant: "impl-a" }, roster);

    expect(world.notices.told).toEqual(["tp-operator"]);
    expect(await digestSeats(world, roster)).toEqual(["tp-operator"]);
  });

  it("a restarted successor run keeps the original registrant when the successor registers the PR again", async () => {
    const world = await redRun({ registrant: "tp-operator", successor: "impl-a-s1" });

    expect(world.store.get().byRun(world.runId)?.registrant).toEqual({ name: "tp-operator", fixer: false });
    expect(world.notices.told).toEqual(["tp-operator"]);
    expect(await digestSeats(world)).toEqual(["tp-operator"]);
  });

  it("a restarted successor of a fixer that registered its own PR still sends to the session that spawned that fixer", async () => {
    const roster = [agentRow("impl-a", "tp-operator"), agentRow("impl-a-next", "human")];
    const world = await redRun({ registrant: "impl-a", successor: "impl-a-next" }, roster);

    expect(world.notices.told).toEqual(["tp-operator"]);
    expect(await digestSeats(world, roster)).toEqual(["tp-operator"]);
  });

  it("a run with no registrant sends its seat notice and digest to the repo's live seat, as before", async () => {
    const world = await redRun({});

    expect(world.notices.told).toEqual([REPO_SEAT]);
    expect(noticeRecord(world)).toMatchObject({ sent: true, seat: REPO_SEAT, detail: `told ${REPO_SEAT}` });
    expect(await digestSeats(world)).toEqual([REPO_SEAT]);
  });

  it("a run whose non-fixer registrant has retired sends its seat notice and digest to the repo's seat (TP-3958)", async () => {
    const roster = [retiredRow("tp-operator")];
    const world = await redRun({ registrant: "tp-operator" }, roster);

    expect(world.notices.told).toEqual([REPO_SEAT]);
    expect(await digestSeats(world, roster)).toEqual([REPO_SEAT]);
  });
});

describe("a seat notice for a seat with no live session goes to a configured fallback (TP-3958)", () => {
  const FALLBACKS: NoticeFallbacks = { redSeat: { repos: { [REPO.toUpperCase()]: "red-coord" }, fallback: "red-fallback" }, hubSeat: "hub-coord" };

  it("a retired repo seat's notice goes to the repo's red seat, and the record names the fallback", async () => {
    const world = await redRun({}, [retiredRow(REPO_SEAT), liveRow("red-coord"), liveRow("hub-coord")], FALLBACKS);

    expect(world.notices.told).toEqual(["red-coord"]);
    expect(noticeRecord(world)).toMatchObject({ sent: true, seat: "red-coord", detail: `told red-coord (${REPO_SEAT} holds no live session, so shepherd.redSeat.repos red-coord was told)` });
  });

  it("skips fallbacks with no live session, down to the hub seat", async () => {
    const world = await redRun({}, [retiredRow(REPO_SEAT), retiredRow("red-coord"), liveRow("hub-coord")], FALLBACKS);

    expect(world.notices.told).toEqual(["hub-coord"]);
    expect(noticeRecord(world)).toMatchObject({ detail: `told hub-coord (${REPO_SEAT} holds no live session, so shepherd.hubSeat hub-coord was told)` });
  });

  it("opens the owner gate, naming why, when neither the seat nor any fallback holds a live session", async () => {
    const world = startRed({}, [retiredRow(REPO_SEAT)], BOOK, FALLBACKS);

    await gateOpened(world.host, gateId(world.runId, "ci-failed"));

    expect(world.notices.told).toEqual([]);
    expect(noticeRecord(world)).toMatchObject({ sent: false, seat: REPO_SEAT, detail: `${REPO_SEAT} holds no live session and no fallback seat does` });
  });
});

describe("a registrant never stands in for a repo no single seat owns: the owner gate opens (TP-3653)", () => {
  const books: Record<string, SeatBook> = {
    "deny-listed or charter hard-stopped": { ...BOOK, denied: [REPO.toLowerCase()] },
    unseated: { seats: [], denied: [] },
    "joined by several seats (`+`)": { seats: [seatOf(REPO_SEAT), seatOf("other-coord")], denied: [] },
  };

  it.each(Object.entries(books))("a repo %s opens ci-failed for the owner and sends neither notice nor digest", async (_name, book) => {
    const world = startRed({ registrant: "tp-operator" }, [], book);

    await gateOpened(world.host, gateId(world.runId, "ci-failed"));

    expect(world.notices.told).toEqual([]);
    expect(await digestSeats(world)).toEqual([]);
  });

  it("a fixer-registered run in a deny-listed repo opens the owner gate rather than telling its spawner", async () => {
    const roster = [agentRow("impl-a", "tp-operator")];
    const world = startRed({ registrant: "impl-a" }, roster, { ...BOOK, denied: [REPO.toLowerCase()] });

    await gateOpened(world.host, gateId(world.runId, "ci-failed"));

    expect(world.notices.told).toEqual([]);
    expect(await digestSeats(world, roster)).toEqual([]);
  });
});
