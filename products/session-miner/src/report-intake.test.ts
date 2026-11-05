import { describe, expect, it } from "vitest";
import { concernClass, intakeRow, isCloseout } from "./report-intake.js";

const record = (body: string) => ({ eventId: 1, at: "2030-03-10T12:00:00.000Z", agent: "w1", coordinator: "coord", spawnedAt: null, body });

describe("worker-report intake rows", () => {
  it("turns a plain DONE with a PR into the closeout actions and the parsed header", () => {
    const row = intakeRow(record(["Status: DONE", "PR: o/r#9", "Head: 0123456789abcdef", "CI:", "unit\tpass\t1m", "Concerns: none", "Notes: none"].join("\n")));

    expect(row).toEqual(expect.objectContaining({ status: "DONE", pr: "o/r#9", head: "0123456789abcdef", ci: "pass", concerns: [] }));
    expect(row.actions).toEqual(["verify-head", "ensure-shepherd", "note-task", "retire", "park-tree"]);
  });

  it("closes out a plan with no PR by copying the plan", () => {
    expect(intakeRow(record("Status: DONE\nPR: none\nPlan: /aw/x/sources/p.md\nConcerns: none")).actions).toEqual(["copy-plan", "note-task", "retire"]);
  });

  it("closes out DONE_WITH_CONCERNS when every concern is a known class", () => {
    const row = intakeRow(record("Status: DONE_WITH_CONCERNS\nPR: o/r#9\nConcerns:\n- the gh visibility check was refused twice\n- a lint failure is pre-existing on main"));

    expect(row.concerns.map((c) => c.class)).toEqual(["visibility-denied", "pre-existing-failure"]);
    expect(isCloseout(row.actions)).toBe(true);
  });

  it("puts a report with a residual concern in front of the seat", () => {
    const row = intakeRow(record("Status: DONE_WITH_CONCERNS\nPR: o/r#9\nConcerns: the owner should pick a name for the flag"));

    expect(row.concerns).toEqual([{ class: "residual", text: "the owner should pick a name for the flag" }]);
    expect(row.actions).toEqual(["enqueue-for-seat"]);
  });

  it("backs off a BLOCKED report whose only cause is a denial", () => {
    expect(intakeRow(record("Status: BLOCKED\nPR: none\nFriction: the push was denied by the auto mode classifier")).actions).toEqual(["count-friction", "resume-after-backoff"]);
  });

  it.each([
    ["an unreadable report", "I think it is finished"],
    ["NEEDS_CONTEXT", "Status: NEEDS_CONTEXT\nPR: none"],
    ["BLOCKED on a design question", "Status: BLOCKED\nConcerns: which schema should win is unclear"],
  ])("enqueues %s for the seat", (_, body) => {
    expect(intakeRow(record(body)).actions).toEqual(["enqueue-for-seat"]);
  });
});

describe("concern prefilter", () => {
  it.each([
    ["CI was not read before the report", "ci-unread"],
    ["Follow-up filed as TP-9001", "follow-up-filed"],
    ["I could not verify it against the live service", "could-not-verify"],
    ["three tests fail on main too", "pre-existing-failure"],
    ["the leak guard denied the visibility read", "visibility-denied"],
    ["the reviewer wants a smaller diff", "residual"],
  ])("classes %j as %s", (text, cls) => {
    expect(concernClass(text)).toBe(cls);
  });
});
