import { fromDeposit, ownerCardSchema } from "@titan-design/owner-queue";
import { describe, expect, it } from "vitest";
import { demotionDeposit } from "./cards.js";

const FLAG = { class: "D4", answered: 20, approved: 20, rate: 1, held: [], audited: true };

describe("demotionDeposit", () => {
  it("files a two-way card that passes every card rule, keeps by default and waits on silence", () => {
    const deposit = demotionDeposit(FLAG, "2026-W42");

    const item = fromDeposit(deposit, new Date("2026-10-12T06:00:00Z"));

    expect(ownerCardSchema.safeParse(item).success).toBe(true);
    expect(item).toMatchObject({ door: "two-way", class: "D4", default: "keep", onSilence: { action: "wait" } });
    expect(item.options?.map((option) => option.id)).toEqual(["keep", "demote-a", "demote-b", "demote-c"]);
  });

  it("never claims an audit cleared the class when no audit result was consulted", () => {
    const { context } = demotionDeposit({ ...FLAG, audited: false }, "2026-W42");

    expect(context).not.toMatch(/audit sample found no/);
    expect(context).toContain("No audit result was consulted");
  });

  it("says the audit sample found nothing bad only when an audit was consulted", () => {
    expect(demotionDeposit(FLAG, "2026-W42").context).toContain("The audit sample found no revert, red main or incident in it.");
  });

  it("names the deposit by week and class, so a re-run of the same week files it once", () => {
    expect(demotionDeposit(FLAG, "2026-W42").depositId).toBe(demotionDeposit({ ...FLAG, approved: 19 }, "2026-W42").depositId);
    expect(demotionDeposit(FLAG, "2026-W43").depositId).not.toBe(demotionDeposit(FLAG, "2026-W42").depositId);
  });
});
