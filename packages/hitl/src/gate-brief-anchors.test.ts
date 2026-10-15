import { lineSourceFromTexts } from "@titan-design/evidence";
import { describe, expect, it } from "vitest";
import { snapshotBrief } from "./gate-brief.js";
import { GateBriefInvalid } from "./types.js";

const HEAD = "d".repeat(40);
const fifteen = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const anchors = {
  pins: { repo: "example/repo", head: HEAD },
  source: (rev: string) => lineSourceFromTexts(rev === HEAD ? { "src/a.ts": fifteen } : {}),
};
const brief = (evidenceRef: string) => ({ summary: "Merge example#1? CI green.", evidenceRef });

function issuesOf(act: () => unknown): string[] {
  try {
    act();
  } catch (error) {
    if (error instanceof GateBriefInvalid) return error.issues;
    throw error;
  }
  throw new Error("expected GateBriefInvalid");
}

describe("snapshotBrief with an anchor source", () => {
  it("refuses an anchor-form evidenceRef that ends past EOF at the pinned head", () => {
    expect(issuesOf(() => snapshotBrief("g1", brief("head/src/a.ts#L10-L20"), true, anchors))).toEqual([
      "evidenceRef head/src/a.ts#L10-L20: past EOF (15 lines)",
    ]);
  });

  it("accepts an anchor that holds at the pinned head", () => {
    expect(snapshotBrief("g1", brief("head/src/a.ts#L10-L15"), true, anchors).evidenceRef).toBe("head/src/a.ts#L10-L15");
  });

  it("leaves a free-string evidenceRef legal", () => {
    expect(snapshotBrief("g1", brief("https://example.test/pr/1/checks"), true, anchors).evidenceRef).toBe("https://example.test/pr/1/checks");
  });

  it("does not read files without a source, as before", () => {
    expect(snapshotBrief("g1", brief("head/src/a.ts#L10-L20"), true).evidenceRef).toBe("head/src/a.ts#L10-L20");
  });
});
