import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff.js";
import { PATCH } from "./pr-fakes.test-helpers.js";

describe("parseDiff", () => {
  it("reads each file's status, counts and head-side hunk ranges", () => {
    const files = parseDiff(PATCH);

    expect(files).toEqual([
      { path: "src/api.ts", status: "modified", additions: 3, deletions: 1, hunks: [{ headStart: 1, headLines: 5 }] },
      { path: "src/cache.ts", status: "added", additions: 3, deletions: 0, hunks: [{ headStart: 1, headLines: 3 }] },
      { path: "docs/old.md", status: "deleted", additions: 0, deletions: 2, hunks: [{ headStart: 0, headLines: 0 }] },
      { path: "docs/b.md", status: "renamed", from: "docs/a.md", additions: 1, deletions: 1, hunks: [{ headStart: 1, headLines: 1 }] },
    ]);
  });

  it("does not count the file headers as added or removed lines", () => {
    const [file] = parseDiff("diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n");

    expect(file).toMatchObject({ additions: 1, deletions: 1 });
  });

  it("returns no files for an empty patch", () => {
    expect(parseDiff("")).toEqual([]);
  });
});
