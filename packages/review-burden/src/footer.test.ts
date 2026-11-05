import { describe, expect, it } from "vitest";
import { hasContract, parseFooter } from "./footer.js";

const FULL = [
  "Adds the queue view.",
  "",
  "---",
  "<!-- merge-danger:v1 -->",
  "**Merge danger**",
  "- Door: two-way",
  "- Blast radius: `packages/ledger` only. No consumer imports the new export yet.",
  "- Rollback: revert this PR.",
  "- Contract: TP-0001 V1-V3 (sha256:0a1b2c3d)",
  "",
  "Generated with a tool",
].join("\n");

describe("parseFooter", () => {
  it("reads all four keys of a full footer as present", () => {
    expect(parseFooter(FULL)).toEqual({
      door: "two-way",
      blastRadius: "`packages/ledger` only. No consumer imports the new export yet.",
      rollback: "revert this PR.",
      contract: "TP-0001 V1-V3 (sha256:0a1b2c3d)",
      present: true,
    });
  });

  it("is not present when a key is missing", () => {
    const footer = parseFooter(FULL.replace("- Rollback: revert this PR.\n", ""));

    expect(footer.present).toBe(false);
    expect(footer.rollback).toBeUndefined();
    expect(footer.door).toBe("two-way");
  });

  it("is not present when a key is empty", () => {
    expect(parseFooter(FULL.replace("- Rollback: revert this PR.", "- Rollback:   ")).present).toBe(false);
  });

  it("is not present when the door is neither one-way nor two-way", () => {
    const footer = parseFooter(FULL.replace("Door: two-way", "Door: probably fine"));

    expect(footer.present).toBe(false);
    expect(footer.door).toBeUndefined();
  });

  it("finds nothing without the marker, even when the keys are written", () => {
    expect(parseFooter(FULL.replace("<!-- merge-danger:v1 -->", ""))).toEqual({ present: false });
  });

  it("reads only the block after the last marker", () => {
    const body = `${FULL}\n\n<!-- merge-danger:v1 -->\n- Door: one-way\n- Blast radius: stored sessions\n- Rollback: restore the backup\n- Contract: none`;

    expect(parseFooter(body)).toMatchObject({ door: "one-way", blastRadius: "stored sessions", present: true });
  });

  it("keeps the first line for a repeated key", () => {
    const body = FULL.replace("- Contract: TP-0001", "- Door: one-way\n- Contract: TP-0001");

    expect(parseFooter(body).door).toBe("two-way");
  });

  it("accepts CRLF line ends, star bullets, any key case and a bold door", () => {
    const body = "<!-- merge-danger:v1 -->\r\n* door: **One-Way**\r\n* BLAST RADIUS: the store\r\n* rollback: none\r\n* contract: none\r\n";

    expect(parseFooter(body)).toMatchObject({ door: "one-way", blastRadius: "the store", present: true });
  });
});

describe("hasContract", () => {
  it.each([
    ["TP-0001 V1-V3 (sha256:0a1b2c3d)", true],
    ["none", false],
    ["None", false],
    ["`none`", false],
  ])("reads contract %s as %s", (contract, expected) => {
    expect(hasContract({ contract, present: true })).toBe(expected);
  });

  it("reads a missing contract line as no contract", () => {
    expect(hasContract({ present: false })).toBe(false);
  });
});
