import { describe, expect, it } from "vitest";
import { UNLOCK_PARITY } from "./unlock-parity.fixture.js";
import { checkUnlock, unlockTableRow } from "./unlock.js";

describe("unlock table parity with agent-chat", () => {
  it.each(UNLOCK_PARITY)("$question / $answer ($category) matches agent-chat", (c) => {
    const row = unlockTableRow(c.question) ?? unlockTableRow(c.answer) ?? null;
    const check = checkUnlock(c.question, c.answer, c.category);

    expect(row).toBe(c.row);
    expect(check.ok ? "ok" : check.code).toBe(c.decision);
  });

  it("covers every outcome agent-chat can return without a citation problem", () => {
    expect(new Set(UNLOCK_PARITY.map((c) => c.decision))).toEqual(new Set(["ok", "not_decidable", "unlock_table"]));
  });
});

describe("checkUnlock", () => {
  it("refuses an unlock carried in the answer even when the question is clean", () => {
    const check = checkUnlock("Which schema version?", "delete the old one", "tech_design");

    expect(check).toEqual({
      ok: false,
      code: "unlock_table",
      reason: expect.stringContaining("deletion"),
    });
  });
});
