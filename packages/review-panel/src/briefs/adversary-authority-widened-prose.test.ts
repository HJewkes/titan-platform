import { describe, expect, it } from "vitest";
import { authorityLine } from "./adversary.js";

const unchanged = "Authority: unchanged";

/** Any wording of a widening; the parser never needs to understand it, since only the two exact safe lines read safe. */
const WIDENING_PROSE: readonly string[] = [
  "**Authority widened:** the lander can now merge without review",
  "**Authority widened.** The new route skips the guard.",
  "Authority widened by letting the bot merge.",
  "Authority widened — see above",
  "**Authority widens:** the bot can now merge",
  "**Authority widening.** The bot can now merge without review.",
  "Authority widening: yes",
  "**Authority widen.** The new route skips the guard.",
  "Authority — wider: yes",
  "Authority is widened: bot merges",
  "Authority gate: widens",
  "Authority check: widening, for the bot",
  "Authority grows: bot merges",
  "Authority now covers the bot",
  "Authority: bot may merge",
];

describe("authorityLine prose that states a widening beside Authority: unchanged", () => {
  it.each(WIDENING_PROSE)("%s never reads unchanged", (prose) => {
    expect(authorityLine(`${prose}\n${unchanged}`)).not.toBe("unchanged");
  });
});
