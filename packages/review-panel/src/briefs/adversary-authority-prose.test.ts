import { describe, expect, it } from "vitest";
import { authorityLine, malformedAuthorityLines } from "./adversary.js";

const probes = "Probes: empty token -> refused; second caller -> refused";
const tail = "Authority: unchanged\n\nVerdict: MERGE";

describe("authorityLine prose that starts with the word Authority", () => {
  it.each([
    ["a bold paragraph lead", "**Authority gate.** No console tap reaches the write path; every route goes through the guard."],
    ["a bold bullet lead", "- **Authority check first.** applyOp calls the guard before any write."],
    ["a plain bullet lead", "- Authority check first. applyOp calls the guard before any write."],
    ["a paragraph with a colon later in the prose", "**Authority gate.** No console tap: the only caller is the guarded route."],
  ])("%s above a plain unchanged line reads unchanged", (_shape, prose) => {
    expect(authorityLine(`${probes}\n\n${prose}\n\n${tail}`)).toBe("unchanged");
  });

  it.each([
    ["bold", "**Authority:** widened"],
    ["block-quoted lower-case", "> authority: widened"],
    ["worded label", "Authority gate: widened"],
    ["dash instead of colon", "Authority - widened"],
  ])("a %s widened line still reads widened over unchanged", (_shape, widened) => {
    expect(authorityLine(`${probes}\n${widened}\n${tail}`)).toBe("widened");
  });

  it("a widened line hidden mid-reply under prose leads still reads widened", () => {
    const reply = `${probes}\n\n**Authority gate.** No console tap.\n\nThe guard holds.\nAuthority: widened\nMore prose.\n\n${tail}`;

    expect(authorityLine(reply)).toBe("widened");
  });

  it("a labelled line with an unknown value still reads malformed", () => {
    expect(authorityLine(`${probes}\nAuthority: maybe\n${tail}`)).toBe("malformed");
  });

  it("prose leads with no Authority line read undefined", () => {
    expect(authorityLine(`${probes}\n**Authority gate.** No console tap.\n\nVerdict: MERGE`)).toBeUndefined();
  });
});

describe("malformedAuthorityLines", () => {
  it("names the first line that reads malformed, trimmed", () => {
    expect(malformedAuthorityLines(`${probes}\n  Authority: maybe  \nAuthority: unsure\n${tail}`)).toEqual(["Authority: maybe"]);
  });

  it("names nothing when every labelled line reads a known value", () => {
    expect(malformedAuthorityLines(`${probes}\n**Authority gate.** No console tap.\n${tail}`)).toEqual([]);
  });
});
