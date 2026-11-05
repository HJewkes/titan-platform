import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { roundShips, type HeldAt, type StoredRound } from "./round-ship-sweep.js";
import { isoWeek, visualWeekBatch } from "./visual-week.js";
import { NOW, REPO, headOf, notHeld, parked, world } from "./visual-week.test-helpers.js";

const batchOf = (parts: ReturnType<typeof parked>[], heldAt: HeldAt = notHeld) => visualWeekBatch({ repo: REPO, ...world(...parts), heldAt, now: NOW });

describe("visualWeekBatch", () => {
  it("batches only pending visual-path gates at a current unheld head", () => {
    const held: HeldAt = (_repo, pr) => (pr === 3 ? "g10 review" : undefined);
    const batch = batchOf([parked(1), parked(2, "skill-path"), parked(3), parked(4, "visual-path", headOf(9))], held);
    expect(batch.questions.map((question) => question.merge.pr)).toEqual([1]);
    expect(batch.skipped).toEqual([
      { pr: 2, reason: expect.stringContaining("not a visual-path gate") },
      { pr: 3, reason: "held: g10 review" },
      { pr: 4, reason: expect.stringContaining("not a visual-path gate") },
    ]);
  });

  it("names the unit for the ISO week and binds each question to the gate's head with only Ship as a ship option", () => {
    const batch = batchOf([parked(1)]);
    expect(batch.unit).toBe("td-ship-week-2026-W45");
    expect(batch.questions[0]!.merge).toEqual({ repo: REPO, pr: 1, headSha: headOf(1), ship: ["Ship"] });
  });

  it("a batch built without pr-visual reads carries no sections", () => {
    expect(batchOf([parked(1)])).not.toHaveProperty("sections");
  });

  it("another repo's gates are left out of the batch", () => {
    const other = parked(1);
    other.gate.gate.prompt = other.gate.gate.prompt.replace(REPO, "example-org/other-repo");
    expect(batchOf([other]).questions).toEqual([]);
  });

  it("a batch round with Ship on two of three PRs resolves those two through roundShips", () => {
    const parts = [parked(1), parked(2), parked(3)];
    const batch = batchOf(parts);
    const round = Buffer.from(JSON.stringify(batch));
    const answers = [{ questionId: "pr-1", pick: "Ship" }, { questionId: "pr-2", pick: "Ship" }, { questionId: "pr-3", pick: "Don't ship" }];
    const feedback = Buffer.from(JSON.stringify({ unit: batch.unit, round: 1, manifestSha256: createHash("sha256").update(round).digest("hex"), submittedAt: "2026-11-04T08:30:00.000Z", answers }));
    const stored: StoredRound = { id: `${batch.unit}-r1`, round, feedback, builtAtMs: 0 };
    const ships = roundShips([stored], world(...parts).gates, world(...parts).runs, NOW, notHeld);
    expect(ships.filter((ship) => ship.kind === "resolve").map((ship) => ({ runId: ship.runId, headSha: ship.payload.headSha }))).toEqual([
      { runId: "run-1", headSha: headOf(1) },
      { runId: "run-2", headSha: headOf(2) },
    ]);
    expect(ships.find((ship) => ship.kind === "pending")).toMatchObject({ pr: `${REPO}#3` });
  });

  it("a moved head rolls to the next week", () => {
    const batch = batchOf([parked(1)]);
    const moved = parked(1);
    const newHead = "c".repeat(40);
    moved.gate.gate.prompt = moved.gate.gate.prompt.replace(headOf(1), newHead);
    moved.run.stepResults["merge-policy:0"]!.output = moved.run.stepResults["merge-policy:0"]!.output!.replace(headOf(1), newHead);
    const round = Buffer.from(JSON.stringify(batch));
    const feedback = Buffer.from(JSON.stringify({ unit: batch.unit, round: 1, manifestSha256: createHash("sha256").update(round).digest("hex"), submittedAt: "2026-11-04T08:30:00.000Z", answers: [{ questionId: "pr-1", pick: "Ship" }] }));
    const ships = roundShips([{ id: "r1", round, feedback, builtAtMs: 0 }], [moved.gate], [moved.run], NOW, notHeld);
    expect(ships).toEqual([expect.objectContaining({ kind: "pending", reason: expect.stringContaining("PR moved") })]);
    expect(batchOf([moved]).questions[0]!.merge.headSha).toBe(newHead);
  });
});

describe("isoWeek", () => {
  it("reads the year a late-December day belongs to", () => {
    expect(isoWeek(new Date("2026-12-31T12:00:00.000Z"))).toBe("2026-W53");
    expect(isoWeek(new Date("2027-01-01T12:00:00.000Z"))).toBe("2026-W53");
    expect(isoWeek(new Date("2027-01-04T00:00:00.000Z"))).toBe("2027-W01");
  });
});
