import { describe, expect, it } from "vitest";
import { refusalMessageOf } from "./refusal-message.js";

const CASES: ReadonlyArray<readonly [string, RegExp]> = [
  ["record", /record.*(read it again|open the item again)/i],
  ["record-unreadable", /could not be read.*read the item again/i],
  ["class", /no path.*terminal/i],
  ["evidence", /evidence.*read the item again/i],
  ["mismatch", /changed.*read the item again/i],
  ["resolver", /not allowed.*terminal/i],
  ["payload", /answer.*not valid.*read the item again/i],
  ["github-unreadable", /GitHub.*tap again later/i],
  ["agent-chat-unavailable", /agent-chat.*tap again later/i],
  ["deploying", /deploy.*tap again later/i],
  ["plan-busy", /plan.*tap again later/i],
  ["too-large", /too large.*shorten/i],
  ["bad-request", /not understood.*read the item again/i],
  ["shepherd", /Shepherd.*refused/i],
];

describe("refusalMessageOf", () => {
  it.each(CASES)("turns %s into a plain sentence with a next step", (reason, expected) => {
    const message = refusalMessageOf(reason, undefined);

    expect(message).toMatch(expected);
    expect(message).not.toContain(`(${reason})`);
  });

  it("appends the detail to a known code", () => {
    expect(refusalMessageOf("deploying", "deployer run r1 is live")).toContain("deployer run r1 is live");
  });

  it("falls back to the raw code plus detail for an unknown code", () => {
    expect(refusalMessageOf("brand-new", "something odd")).toBe("Refused (brand-new): something odd");
  });

  it("falls back to the raw code alone when no detail came", () => {
    expect(refusalMessageOf("brand-new", undefined)).toBe("Refused (brand-new)");
  });
});
