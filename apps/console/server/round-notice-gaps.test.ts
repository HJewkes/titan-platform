import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoundListeners, type ListenerDeps } from "./listeners.js";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { fileRound } from "./round-file.js";
import { missedNoticeRows } from "./round-notice-gaps.js";
import type { SeatNotifier } from "./round-notice-transport.js";

// Synthetic: a questions-only fixture round filed by a made-up seat, in a temp state dir.
const ROUND = "kiln-schedule-r2";
const SEAT = "sample-seat";
const NOW = new Date("2026-10-20T12:00:00.000Z");
const LATER = new Date("2026-10-20T13:00:00.000Z");

let roundsDir: string;
let sent: string[];

beforeEach(async () => {
  roundsDir = path.join(await mkdtemp(path.join(tmpdir(), "console-notice-gaps-")), "rounds");
  sent = [];
  const body = await readFile(path.join(FIXTURE_ROUNDS.dir, ROUND, "round.json"), "utf8");
  await fileRound({ body, roundsDir, asker: { seat: SEAT, initiative: null } });
  await writeFile(path.join(roundsDir, ROUND, "feedback.json"), "{}\n");
});

afterEach(async () => {
  await rm(path.dirname(roundsDir), { recursive: true, force: true });
});

const delivers: SeatNotifier = async (seat) => void sent.push(seat);
const fails =
  (message: string): SeatNotifier =>
  () =>
    Promise.reject(new Error(message));

function listeners(notify: SeatNotifier, now = NOW) {
  const unused = () => Promise.reject(new Error("no factory in this test"));
  const deps: ListenerDeps = { enabled: false, roundsDir, shepherd: { list: unused }, answer: { post: unused }, notify, now: () => now };
  return createRoundListeners(deps);
}

const rows = () => missedNoticeRows(roundsDir, LATER.getTime());

describe("missed round-notice rows in the inbox", () => {
  it("shows one row naming the round, the seat and the error when the sweep's retry fails too", async () => {
    await listeners(fails("no live session")).afterRoundSubmit(ROUND, { status: "submitted" });
    await listeners(fails("seat sample-seat is not live")).sweep();

    expect(await rows()).toEqual([
      {
        id: `derived:missed-notice:${ROUND}:${SEAT}`,
        kind: "missed-notice",
        summary: `${SEAT} was not told the owner answered round ${ROUND}`,
        evidence: { observed: "notice failed after the start-up sweep's retry: seat sample-seat is not live", source: `round notice ${ROUND} to ${SEAT}`, at: NOW.toISOString() },
        threshold: { name: "a round notice the start-up sweep could not send", limitMs: 0, ageMs: LATER.getTime() - NOW.getTime() },
        link: `#/rounds/${ROUND}`,
      },
    ]);
  });

  it("shows no row when only the live send failed and the sweep's retry reached the seat", async () => {
    await listeners(fails("no live session")).afterRoundSubmit(ROUND, { status: "submitted" });
    await listeners(delivers).sweep();

    expect(sent).toEqual([SEAT]);
    expect(await rows()).toEqual([]);
  });

  it("clears the row once a later sweep reaches the seat", async () => {
    await listeners(fails("no live session")).sweep();
    expect(await rows()).toHaveLength(1);

    await listeners(delivers, LATER).sweep();

    expect(sent).toEqual([SEAT]);
    expect(await rows()).toEqual([]);
  });

  it("names the latest error when a later sweep fails again", async () => {
    await listeners(fails("first error")).sweep();
    await listeners(fails("second error"), LATER).sweep();

    expect((await rows()).map((row) => [row.evidence.observed, row.evidence.at])).toEqual([["notice failed after the start-up sweep's retry: second error", LATER.toISOString()]]);
  });

  it("reads no rows from a rounds dir that does not exist", async () => {
    expect(await missedNoticeRows(path.join(roundsDir, "missing"), LATER.getTime())).toEqual([]);
  });
});
