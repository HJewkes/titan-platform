import { describe, expect, it } from "vitest";
import { authorityLine } from "./adversary.js";

const unchanged = "Authority: unchanged";

describe("authorityLine prose that starts with Authority and states a widening", () => {
  it.each([
    ["a bold worded label", "**Authority widened:** the lander can now merge without review"],
    ["a bold sentence lead", "**Authority widened.** The new route skips the guard."],
    ["a plain sentence", "Authority widened by letting the bot merge."],
    ["a dash aside", "Authority widened — see above"],
    ["a bold label in another inflection", "**Authority widens:** the bot can now merge"],
    ["a sentence lead in another inflection", "**Authority widening.** The bot can now merge without review."],
    ["a plain label in another inflection", "Authority widening: yes"],
    ["the bare stem", "**Authority widen.** The new route skips the guard."],
    ["a comparative", "Authority — wider: yes"],
    ["a label glued to the widening", "Authority-widens: bot merges"],
  ])("%s that starts with a widening reads widened over an unchanged line", (_shape, prose) => {
    expect(authorityLine(`${prose}\n${unchanged}`)).toBe("widened");
  });

  it.each(["Authority is widened: bot merges", "Authority gate: widens", "Authority check: widening, for the bot"])("a widening later in the lead, %s, reads malformed, never unchanged", (prose) => {
    expect(authorityLine(`${prose}\n${unchanged}`)).toBe("malformed");
  });

  it.each(["**Authority gate.** No console tap.", "Authority check first. applyOp calls the guard.", "**Authority gate.** No repo-wide network change."])("a lead with no widening, %s, still gives no reading", (prose) => {
    expect(authorityLine(`${prose}\n${unchanged}`)).toBe("unchanged");
  });
});
