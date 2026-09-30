import { describe, expect, it } from "vitest";
import { parseCommit, parseDiff, unquotePath } from "./diff.js";

const planted = ["", "Users", "planted" + "-name"].join("/");

const twoHunks = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -2,0 +3,2 @@ function a() {",
  "+first",
  "+second",
  "@@ -40,2 +42,1 @@ function b() {",
  `-removed ${planted}`,
  "-removed again",
  "+third",
].join("\n");

describe("parseDiff", () => {
  it("numbers added lines from each hunk's new-side start", () => {
    const [file] = parseDiff(twoHunks).files;
    expect(file?.path).toBe("src/app.ts");
    expect(file?.lines).toEqual([
      { line: 3, text: "first" },
      { line: 4, text: "second" },
      { line: 42, text: "third" },
    ]);
  });

  it("drops removed lines", () => {
    const texts = parseDiff(twoHunks).files.flatMap((f) => f.lines.map((l) => l.text));
    expect(texts.some((text) => text.includes(planted))).toBe(false);
  });

  it("keeps an added line that looks like a file header", () => {
    const diff = ["diff --git a/x.md b/x.md", "--- a/x.md", "+++ b/x.md", "@@ -1,0 +1,2 @@", "+++ b/elsewhere", "+diff --git a b"].join("\n");
    expect(parseDiff(diff).files[0]?.lines.map((l) => l.text)).toEqual(["++ b/elsewhere", "diff --git a b"]);
  });

  it("skips and counts a binary file while keeping its path", () => {
    const diff = [
      "diff --git a/img/logo.png b/img/logo.png",
      "new file mode 100644",
      "index 0000000..3333333",
      "Binary files /dev/null and b/img/logo.png differ",
      "diff --git a/b.txt b/b.txt",
      "--- a/b.txt",
      "+++ b/b.txt",
      "@@ -0,0 +1 @@",
      "+text",
    ].join("\n");
    const parsed = parseDiff(diff);
    expect(parsed.binaryFiles).toBe(1);
    expect(parsed.files[0]).toMatchObject({ path: "img/logo.png", binary: true, pathAdded: true, lines: [] });
    expect(parsed.files[1]?.lines).toEqual([{ line: 1, text: "text" }]);
  });

  it("takes the new path of a pure rename and marks it added", () => {
    const diff = ["diff --git a/old name.md b/new name.md", "similarity index 100%", "rename from old name.md", "rename to new name.md"].join("\n");
    expect(parseDiff(diff).files[0]).toMatchObject({ path: "new name.md", pathAdded: true });
  });

  it("unquotes an escaped path", () => {
    const diff = ['diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"', "new file mode 100644"].join("\n");
    expect(parseDiff(diff).files[0]).toMatchObject({ path: "café.md", pathAdded: true });
  });

  it("ignores the no-newline marker", () => {
    const diff = ["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1 +1 @@", "-old", "\\ No newline at end of file", "+new", "\\ No newline at end of file"].join("\n");
    expect(parseDiff(diff).files[0]?.lines).toEqual([{ line: 1, text: "new" }]);
  });

  it("reads added lines of a combined merge diff", () => {
    const diff = ["diff --cc merged.ts", "index 1,2..3", "@@@ -5,2 -5,0 +5,2 @@@", "- theirs", " +resolved", "++both"].join("\n");
    expect(parseDiff(diff).files[0]?.lines).toEqual([
      { line: 5, text: "resolved" },
      { line: 6, text: "both" },
    ]);
  });
});

describe("parseDiff on a merge diffed against each parent", () => {
  const againstFirst = ["diff --git a/m.txt b/m.txt", "--- a/m.txt", "+++ b/m.txt", "@@ -1,0 +2,2 @@", "+evil", "+ours"];
  const againstSecond = ["diff --git a/m.txt b/m.txt", "new file mode 100644", "--- /dev/null", "+++ b/m.txt"];
  const secondHunk = ["@@ -0,0 +1,2 @@", "+base", "+evil"];

  it("folds one path into one file with each added line once and the path marked new", () => {
    const { files } = parseDiff([...againstFirst, ...againstSecond, ...secondHunk].join("\n"));

    expect(files).toEqual([
      {
        path: "m.txt",
        ordinal: 1,
        pathAdded: true,
        binary: false,
        lines: [
          { line: 2, text: "evil" },
          { line: 3, text: "ours" },
          { line: 1, text: "base" },
        ],
      },
    ]);
  });

  it("counts the path as binary when any parent's diff skipped it", () => {
    const binary = ["diff --git a/m.txt b/m.txt", "Binary files a/m.txt and b/m.txt differ"];

    expect(parseDiff([...againstFirst, ...binary].join("\n")).binaryFiles).toBe(1);
  });
});

describe("parseCommit", () => {
  it("splits the message from the patch at the NUL", () => {
    const parsed = parseCommit("abcdef0123456", `Subject\n\nBody line\n\0\n${twoHunks}`);
    expect(parsed.sha).toBe("abcdef0123456");
    expect(parsed.message).toEqual(["Subject", "", "Body line"]);
    expect(parsed.files).toHaveLength(1);
  });

  it("fails without the NUL separator rather than scanning the message as patch", () => {
    expect(() => parseCommit("abcdef0", "Subject only")).toThrow(/abcdef0/);
  });
});

describe("unquotePath", () => {
  it("leaves an unquoted path alone", () => {
    expect(unquotePath("plain/path.md")).toBe("plain/path.md");
  });

  it("decodes C escapes", () => {
    expect(unquotePath('"a\\tb\\"c\\\\d"')).toBe('a\tb"c\\d');
  });
});
