import { describe, expect, it } from "vitest";
import { parseMainLog, parseNumstat } from "./git.js";
import { parseHunks } from "./hunks.js";

describe("parseNumstat", () => {
  it("reads plain, renamed and binary entries", () => {
    const out = "3\t1\tsrc/a.ts\0" + "2\t0\t\0old/b.ts\0new/b.ts\0" + "-\t-\timg.png\0";
    expect(parseNumstat(out)).toEqual([
      { path: "src/a.ts", additions: 3, deletions: 1 },
      { previousPath: "old/b.ts", path: "new/b.ts", additions: 2, deletions: 0 },
      { path: "img.png", additions: 0, deletions: 0 },
    ]);
  });
});

describe("parseMainLog", () => {
  it("keeps multi-line bodies whole", () => {
    expect(parseMainLog("abc\x1f10\x1fRevert \"x\"\x1fThis reverts commit def.\n\nmore\x1e\n")).toEqual([{ sha: "abc", time: 10, subject: 'Revert "x"', body: "This reverts commit def.\n\nmore" }]);
  });
});

describe("parseHunks", () => {
  it("reads old and new ranges, and a removed line that looks like a file header stays content", () => {
    const diff = ["diff --git a/f.md b/f.md", "--- a/f.md", "+++ b/f.md", "@@ -3,2 +3,0 @@", "--- not a header", "-x", "diff --git a/n.ts b/n.ts", "--- /dev/null", "+++ b/n.ts", "@@ -0,0 +1,4 @@", "+a"].join("\n");
    expect(parseHunks(diff)).toEqual({
      oldSide: [{ path: "f.md", lineStart: 3, lineEnd: 4 }],
      newSide: [
        { path: "f.md", lineStart: 3, lineEnd: 3 },
        { path: "n.ts", lineStart: 1, lineEnd: 4 },
      ],
    });
  });
});
