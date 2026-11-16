import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanTranscript, type RemovalKind } from "./clean.js";

const source = readFileSync(new URL("./fixtures/transcript.txt", import.meta.url), "utf8");
const bytes = Buffer.from(source, "utf8");

function removedText(kind: RemovalKind, options?: Parameters<typeof cleanTranscript>[1]): string[] {
  return cleanTranscript(source, options)
    .removed.filter((span) => span.kind === kind)
    .map((span) => bytes.subarray(span.start, span.end).toString("utf8"));
}

function sponsorRange(): { start: number; end: number } {
  const start = bytes.indexOf("This video is sponsored");
  const end = bytes.indexOf("Now back to the build.");
  return { start, end };
}

describe("cleanTranscript", () => {
  it("removes um, uh and you know as filler spans", () => {
    const fillers = removedText("filler").map((text) => text.replace(/[ ,]+$/, ""));

    expect(fillers).toEqual(["Um", "you know", "uh"]);
  });

  it("removes an immediately repeated word", () => {
    expect(removedText("repeat")).toContain(" the");
  });

  it("removes an immediately repeated phrase", () => {
    expect(removedText("repeat")).toContain(" I think");
  });

  it("removes a caller-supplied cut range as sponsor-cut", () => {
    const range = sponsorRange();

    const { removed } = cleanTranscript(source, { cutRanges: [range] });

    expect(removed).toContainEqual({ ...range, kind: "sponsor-cut" });
  });

  it("removes a paragraph whose shingle Jaccard meets the threshold as near-duplicate", () => {
    const [duplicate] = removedText("near-duplicate", { nearDuplicateThreshold: 0.8 });

    expect(duplicate).toMatch(/^Clamp the frame square.*one at a time today\.$/);
  });

  it("keeps a near-duplicate paragraph when the threshold is above its similarity", () => {
    expect(removedText("near-duplicate", { nearDuplicateThreshold: 0.99 })).toEqual([]);
  });

  it("keeps everything but fillers and repeats when no options are given", () => {
    const kinds = new Set(cleanTranscript(source).removed.map((span) => span.kind));

    expect([...kinds].sort()).toEqual(["filler", "repeat"]);
  });

  it("concatenates kept slices into the cleaned text", () => {
    const result = cleanTranscript(source, {
      cutRanges: [sponsorRange()],
      nearDuplicateThreshold: 0.8,
    });

    const cleaned = Buffer.concat(result.kept.map((r) => bytes.subarray(r.start, r.end))).toString("utf8");

    expect(cleaned).not.toMatch(/\b(um|uh|you know)\b/i);
    expect(cleaned).not.toContain("sponsored");
    expect(cleaned).not.toContain("the the");
    expect(cleaned.match(/Clamp the frame square/g)).toHaveLength(1);
    expect(cleaned).toContain("Welcome back to the workshop.");
  });

  it("partitions the source into kept and removed ranges without gaps or overlap", () => {
    const result = cleanTranscript(source, {
      cutRanges: [sponsorRange()],
      nearDuplicateThreshold: 0.8,
    });

    const all = [...result.kept, ...result.removed].sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const range of all) {
      expect(range.start).toBe(cursor);
      cursor = range.end;
    }
    expect(cursor).toBe(bytes.length);
  });

  it("reports byte offsets, not character offsets, for multibyte text", () => {
    const text = "café um bar";

    const { removed } = cleanTranscript(text);

    expect(removed).toEqual([{ start: 6, end: 9, kind: "filler" }]);
  });
});
