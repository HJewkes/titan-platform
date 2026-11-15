import { describe, expect, it } from "vitest";
import { authorityLine } from "./adversary.js";

const unchanged = "Authority: unchanged";

describe("authorityLine prose that starts with Authority and states a widening", () => {
  it.each([
    ["a bold worded label", "**Authority widened:** the lander can now merge without review"],
    ["a bold sentence lead", "**Authority widened.** The new route skips the guard."],
    ["a plain sentence", "Authority widened by letting the bot merge."],
    ["a dash aside", "Authority widened — see above"],
  ])("%s that starts with widened reads widened over an unchanged line", (_shape, prose) => {
    expect(authorityLine(`${prose}\n${unchanged}`)).toBe("widened");
  });

  it("a widening later in the lead reads malformed, never unchanged", () => {
    expect(authorityLine(`Authority is widened: bot merges\n${unchanged}`)).toBe("malformed");
  });

  it.each(["**Authority gate.** No console tap.", "Authority check first. applyOp calls the guard."])("a lead with no widening, %s, still gives no reading", (prose) => {
    expect(authorityLine(`${prose}\n${unchanged}`)).toBe("unchanged");
  });
});
