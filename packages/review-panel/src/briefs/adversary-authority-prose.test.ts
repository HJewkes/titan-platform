import { describe, expect, it } from "vitest";
import { ADVERSARY_OVERLAY, authorityLine, malformedAuthorityLines } from "./adversary.js";

const probes = "Probes: empty token -> refused; second caller -> refused";
const tail = "Authority: unchanged\n\nVerdict: MERGE";

const PROSE_LEADS: readonly (readonly [string, string])[] = [
  ["a bold paragraph lead", "**Authority gate.** No console tap reaches the write path; every route goes through the guard."],
  ["a bold bullet lead", "- **Authority check first.** applyOp calls the guard before any write."],
  ["a plain bullet lead", "- Authority check first. applyOp calls the guard before any write."],
  ["a paragraph with a colon later in the prose", "**Authority gate.** No console tap: the only caller is the guarded route."],
];

describe("authorityLine prose that starts with the word Authority", () => {
  it.each(PROSE_LEADS)("%s above Authority: unchanged reads malformed, never unchanged", (_shape, prose) => {
    expect(authorityLine(`${probes}\n\n${prose}\n\n${tail}`)).toBe("malformed");
  });

  it.each([
    ["bold", "**Authority:** widened"],
    ["block-quoted lower-case", "> authority: widened"],
  ])("a %s widened line reads widened over unchanged", (_shape, widened) => {
    expect(authorityLine(`${probes}\n${widened}\n${tail}`)).toBe("widened");
  });

  it("a worded widened label, Authority gate: widened, reads widened over unchanged", () => {
    expect(authorityLine(`${probes}\nAuthority gate: widened\n${tail}`)).toBe("widened");
  });
});

describe("malformedAuthorityLines", () => {
  it("names the first prose lead, trimmed", () => {
    const reply = `${probes}\n\n  **Authority gate.** No console tap.  \n- Authority check first. The guard runs.\n\n${tail}`;

    expect(malformedAuthorityLines(reply)).toEqual(["**Authority gate.** No console tap."]);
  });

  it("names nothing when the only labelled line is exact", () => {
    expect(malformedAuthorityLines(`${probes}\nThe guard holds.\n${tail}`)).toEqual([]);
  });
});

describe("ADVERSARY_OVERLAY", () => {
  it("tells the reviewer to start no other line with the word Authority", () => {
    expect(ADVERSARY_OVERLAY.at(-1)).toContain("Start no other line with the word Authority, not even in bold or in a list; a reply where another line does is not read.");
  });
});
