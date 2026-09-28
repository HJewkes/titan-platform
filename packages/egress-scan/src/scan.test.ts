import { describe, expect, it } from "vitest";
import { parseAllow } from "./allow.js";
import { parseCommit, parseDiff } from "./diff.js";
import { scan } from "./scan.js";
import { parseTerms } from "./terms.js";

const planted = ["", "Users", "planted" + "-name", "repo"].join("/");

function addedFile(path: string, lines: string[], start = 1): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +${start},${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

describe("scan", () => {
  it("fails a planted path in an added line, located at file:line", () => {
    const diff = addedFile("docs/guide.md", ["intro", "more", `run it from ${planted}`], 10);
    expect(scan([parseDiff(diff)]).findings).toEqual([{ location: "docs/guide.md:12", rule: "home-path" }]);
  });

  it("passes a clean diff", () => {
    const clean = ["see /UsersGuide/intro", "app/home/page.tsx", ["", "home", "runner", "work"].join("/"), "the active-work CLI"];
    const result = scan([parseDiff(addedFile("src/a.ts", clean))]);
    expect(result.findings).toEqual([]);
  });

  it("reports a planted path in a commit message by sha and message line", () => {
    const text = `Fix the build\n\nCopied from ${planted}\n\0\n${addedFile("a.txt", ["fine"])}`;
    const result = scan([parseCommit("0123456789abcdef", text)]);
    expect(result.findings).toEqual([{ location: "commit 0123456 message:3", rule: "home-path" }]);
  });

  it("reports a rename whose new path is a planted term, without naming the path", () => {
    const diff = ["diff --git a/notes.md b/zq-planted-term.md", "similarity index 100%", "rename from notes.md", "rename to zq-planted-term.md"].join("\n");
    const result = scan([parseDiff(diff)], { terms: parseTerms("# terms\nzq-planted-term") });
    expect(result.findings).toEqual([{ location: "file #1 path", rule: "private-term", termIndex: 2 }]);
  });

  it("names line findings in a flagged file by ordinal, never by path", () => {
    const path = `fixtures/zq-planted-term/${"x"}.md`;
    const diff = `${addedFile("ok.md", ["fine"])}\n${addedFile(path, ["fine", planted])}`;
    const result = scan([parseDiff(diff)], { terms: parseTerms("zq-planted-term") });
    expect(result.findings.map((f) => f.location)).toEqual(["file #2 path", "file #2:2"]);
  });

  it("scans every commit, so a leak removed later in the push still fails", () => {
    const leak = parseCommit("aaaaaaa1", `add\0\n${addedFile("a.md", [planted])}`);
    const fix = parseCommit("bbbbbbb2", ["remove\0", "diff --git a/a.md b/a.md", "--- a/a.md", "+++ b/a.md", "@@ -1 +0,0 @@", `-${planted}`].join("\n"));
    expect(scan([leak, fix]).findings).toEqual([{ location: "commit aaaaaaa a.md:1", rule: "home-path" }]);
  });

  it("suppresses only the allowed rule in matching files and counts it", () => {
    const aw = ["~", ".local", "share", "active-work"].join("/");
    const diff = `${addedFile("REPORT.md", [aw, planted])}\n${addedFile("other.md", [aw])}`;
    const allow = parseAllow("REPORT.md aw-data-path documented miner path, TP-405");
    const result = scan([parseDiff(diff)], { allow });
    expect(result.findings).toEqual([
      { location: "REPORT.md:2", rule: "home-path" },
      { location: "other.md:1", rule: "aw-data-path" },
    ]);
    expect(result.allowed).toEqual({ "home-path": 0, "aw-data-path": 1, "private-term": 0 });
  });

  it("sums binary files across sources", () => {
    const binary = ["diff --git a/a.png b/a.png", "Binary files a/a.png and b/a.png differ"].join("\n");
    expect(scan([parseDiff(binary), parseDiff(binary)]).binaryFilesSkipped).toBe(2);
  });
});
