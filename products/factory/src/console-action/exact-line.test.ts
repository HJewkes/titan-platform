import { describe, expect, it } from "vitest";
import { exactLine, unexactLine } from "./exact-line.js";

/** Characters a screen hides, reorders or breaks on, plus the escape's own syntax, so a generated string exercises every branch. */
const POOL = ["a", "Z", " ", "\u00e9", "\u{1f600}", "\\", "u", "{", "}", "1F", "\n", "\r", "\t", "\u0000", "\u001b", "\u007f", "\u0085", "\u009b", "\u00ad", "\u061c", "\u200b", "\u200e", "\u202e", "\u2066", "\u2028", "\u2029", "\ufeff", "\u3164", "\ufe0f", "\u{e0100}", "\u00a0", "\u2003", "\u2800", "\u{e0001}", "\ud800", "\udfff"];
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|\p{Cs}/u;

/** A fixed-seed generator, so a failing string reproduces. */
function generated(count: number): string[] {
  let seed = 4490;
  const next = (bound: number): number => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) % bound;
  return Array.from({ length: count }, () => Array.from({ length: next(400) }, () => POOL[next(POOL.length)]!).join(""));
}

describe("exactLine", () => {
  it("gives back every generated string exactly, and shows none of the characters a screen could hide or break on", () => {
    const strings = generated(300);

    const shown = strings.map(exactLine);

    expect(shown.map(unexactLine)).toEqual(strings);
    expect(shown.filter((line) => HIDDEN.test(line))).toEqual([]);
  });

  it("escapes the invisible characters a deny-list of controls and format characters misses", () => {
    const invisible = ["\u3164", "\u115f", "\u2800", "\ufe0f", "\u{e0100}", "\u034f", "\u00a0", "\u2003", "\u3000", "\u202f", "\u1680"];

    const shown = invisible.map((char) => exactLine(`a${char}b`));

    expect(shown).toEqual(invisible.map((char) => `a\\u{${char.codePointAt(0)!.toString(16).toUpperCase()}}b`));
  });

  it("leaves the plain space and combining accents as they are", () => {
    expect(exactLine("run: e\u0301")).toBe("run: e\u0301");
  });

  it("writes a hidden character as its code point and a backslash doubled", () => {
    expect(exactLine("a\\b\r\n‮")).toBe("a\\\\b\\u{D}\\u{A}\\u{202E}");
  });
});
