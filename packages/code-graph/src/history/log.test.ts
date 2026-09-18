import { describe, expect, it } from "vitest";
import { entriesWithin, parseChurnLog, resolveRenamedPath, type ChurnEntry } from "./log.js";

describe("parseChurnLog", () => {
  it("returns empty for empty input", () => {
    expect(parseChurnLog("")).toEqual([]);
  });

  it("parses commit headers with author + committer time and numstat lines", () => {
    const text = [
      "abc1234567890abcdef\tJohn Doe\t1700000000",
      "1\t2\tsrc/foo.ts",
      "3\t0\tsrc/bar.ts",
      "",
      "deadbeefcafebabe1234\tJane Smith\t1700086400",
      "5\t5\tsrc/baz.ts",
    ].join("\n");

    expect(parseChurnLog(text)).toEqual<ChurnEntry[]>([
      { commit: "abc1234567890abcdef", author: "John Doe", epoch: 1700000000, filePath: "src/foo.ts", added: 1, deleted: 2 },
      { commit: "abc1234567890abcdef", author: "John Doe", epoch: 1700000000, filePath: "src/bar.ts", added: 3, deleted: 0 },
      { commit: "deadbeefcafebabe1234", author: "Jane Smith", epoch: 1700086400, filePath: "src/baz.ts", added: 5, deleted: 5 },
    ]);
  });

  it("tolerates legacy 2-field headers (no committer time) with epoch 0", () => {
    const text = ["abc1234\tA", "1\t2\tfoo.ts"].join("\n");
    expect(parseChurnLog(text)).toEqual<ChurnEntry[]>([
      { commit: "abc1234", author: "A", epoch: 0, filePath: "foo.ts", added: 1, deleted: 2 },
    ]);
  });

  it("treats binary `-\\t-` lines as zero churn", () => {
    const text = ["abc1234\tA\t1700000000", "-\t-\tassets/logo.png"].join("\n");
    expect(parseChurnLog(text)).toEqual<ChurnEntry[]>([
      { commit: "abc1234", author: "A", epoch: 1700000000, filePath: "assets/logo.png", added: 0, deleted: 0 },
    ]);
  });

  it("ignores stray lines that don't match either shape", () => {
    const text = ["garbage line", "abc1234\tA\t1700000000", "1\t1\tfoo.ts", "more garbage"].join("\n");
    expect(parseChurnLog(text)).toHaveLength(1);
  });

  it("attributes renamed files to their new path", () => {
    const text = ["abc1234\tA", "0\t0\tsrc/{old.ts => new.ts}", "0\t0\told/path.ts => new/path.ts"].join("\n");
    expect(parseChurnLog(text).map((e) => e.filePath)).toEqual(["src/new.ts", "new/path.ts"]);
  });
});

describe("resolveRenamedPath", () => {
  it("passes through plain paths", () => {
    expect(resolveRenamedPath("src/foo.ts")).toBe("src/foo.ts");
  });

  it("resolves brace renames preserving prefix and suffix", () => {
    expect(resolveRenamedPath("src/{old.ts => new.ts}")).toBe("src/new.ts");
    expect(resolveRenamedPath("a/{b => c}/d.ts")).toBe("a/c/d.ts");
  });

  it("resolves arrow renames without braces", () => {
    expect(resolveRenamedPath("old.ts => new.ts")).toBe("new.ts");
    expect(resolveRenamedPath("a/b/old.ts => x/y/new.ts")).toBe("x/y/new.ts");
  });

  it("collapses double slashes from empty segments in brace renames", () => {
    expect(resolveRenamedPath("a/{old => }/b.ts")).toBe("a/b.ts");
  });
});

describe("entriesWithin", () => {
  const DAY = 86400;
  const now = 1000 * DAY;
  const mk = (filePath: string, ageDays: number): ChurnEntry => ({
    commit: filePath,
    author: "a",
    epoch: now - ageDays * DAY,
    filePath,
    added: 1,
    deleted: 0,
  });
  const entries = [mk("recent.ts", 10), mk("mid.ts", 60), mk("old.ts", 150)];

  it("keeps only entries committed within the window", () => {
    expect(entriesWithin(entries, 30, now).map((e) => e.filePath)).toEqual(["recent.ts"]);
    expect(entriesWithin(entries, 90, now).map((e) => e.filePath)).toEqual(["recent.ts", "mid.ts"]);
    expect(entriesWithin(entries, 180, now).map((e) => e.filePath)).toEqual(["recent.ts", "mid.ts", "old.ts"]);
  });
});
