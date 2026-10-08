import { describe, expect, it } from "vitest";
import { accountHoldReason, isAccountHold, parseLimitReset } from "./account-limit.js";

const at = (iso: string) => Date.parse(iso);

describe("parseLimitReset", () => {
  it("reads the 2026-10-08 weekly notice as Oct 10 6pm Denver daylight time", () => {
    const notice = "You've hit your weekly limit · resets Oct 10 at 6pm (America/Denver)";

    expect(parseLimitReset(notice, at("2026-10-08T05:49:00Z"))).toBe(at("2026-10-11T00:00:00Z"));
  });

  it("reads a bare time as its next occurrence, tomorrow when today's has passed", () => {
    const notice = "You've hit your session limit · resets 3pm (America/Denver)";

    expect(parseLimitReset(notice, at("2026-10-08T20:00:00Z"))).toBe(at("2026-10-08T21:00:00Z"));
    expect(parseLimitReset(notice, at("2026-10-08T22:00:00Z"))).toBe(at("2026-10-09T21:00:00Z"));
  });

  it("reads minutes, and a date in the new year when the notice comes at the year's end", () => {
    expect(parseLimitReset("You've hit your weekly limit · resets Jan 2 at 9:30am (UTC)", at("2026-12-31T10:00:00Z"))).toBe(at("2027-01-02T09:30:00Z"));
  });

  it("takes the offset in force at the reset, not at the notice, across a daylight-saving change", () => {
    expect(parseLimitReset("You've hit your weekly limit · resets Nov 2 at 6pm (America/Denver)", at("2026-10-30T12:00:00Z"))).toBe(at("2026-11-03T01:00:00Z"));
  });

  it("names no reset for a zone it does not know, a missing zone or a notice with no reset", () => {
    const now = at("2026-10-08T05:49:00Z");

    expect(parseLimitReset("You've hit your weekly limit · resets Oct 10 at 6pm (Mars/Olympus)", now)).toBeUndefined();
    expect(parseLimitReset("You've hit your weekly limit · resets Oct 10 at 6pm", now)).toBeUndefined();
    expect(parseLimitReset("You've hit your weekly limit", now)).toBeUndefined();
  });
});

describe("accountHoldReason", () => {
  it("starts with account-exhausted and names the account, the reset and the task, and reads as an account hold", () => {
    const reason = accountHoldReason("/accounts/review", at("2026-10-11T00:00:00Z"));

    expect(reason).toBe("account-exhausted: /accounts/review until 2026-10-11T00:00:00.000Z; TP-1955");
    expect(isAccountHold(reason)).toBe(true);
    expect(isAccountHold("owner: waiting on the design call")).toBe(false);
  });

  it("names an unknown reset when the notice gave none", () => {
    expect(accountHoldReason("/accounts/review", null)).toBe("account-exhausted: /accounts/review until an unknown reset; TP-1955");
  });
});
