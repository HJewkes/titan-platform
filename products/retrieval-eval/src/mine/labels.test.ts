import { describe, expect, it } from "vitest";
import { dedupeLabels, labelledPathOf, normaliseLabel } from "./labels.js";

const ROOT = "/Users/x/Library/Application Support/active-work";

describe("labelledPathOf", () => {
  it("takes the file path from a Read", () => {
    expect(labelledPathOf({ name: "Read", input: { file_path: "/a/b.ts" } })).toBe("/a/b.ts");
  });

  it("takes it from Edit and Write too, since both mean the agent went there", () => {
    expect(labelledPathOf({ name: "Edit", input: { file_path: "/a/b.ts" } })).toBe("/a/b.ts");
    expect(labelledPathOf({ name: "Write", input: { file_path: "/a/b.ts" } })).toBe("/a/b.ts");
  });

  it("ignores tools that do not open a file", () => {
    expect(labelledPathOf({ name: "Bash", input: { command: "cat /a/b.ts" } })).toBeUndefined();
    expect(labelledPathOf({ name: "Grep", input: { pattern: "x" } })).toBeUndefined();
  });

  it("ignores a relative path, which cannot be resolved without the cwd", () => {
    expect(labelledPathOf({ name: "Read", input: { file_path: "src/b.ts" } })).toBeUndefined();
  });

  it("normalises a path with redundant segments", () => {
    expect(labelledPathOf({ name: "Read", input: { file_path: "/a/./c/../b.ts" } })).toBe("/a/b.ts");
  });
});

describe("normaliseLabel", () => {
  it("mints a note ref for a file under sources/notes", () => {
    const label = normaliseLabel(`${ROOT}/titan-platform/sources/notes/2026-09-15-x.md`, ROOT);
    expect(label.ref).toBe("note:titan-platform/2026-09-15-x.md");
    expect(label.relative).toBe("titan-platform/sources/notes/2026-09-15-x.md");
  });

  it("mints a source ref for a file directly under sources", () => {
    expect(normaliseLabel(`${ROOT}/titan-platform/sources/00-index.md`, ROOT).ref).toBe(
      "source:titan-platform/00-index.md",
    );
  });

  it("mints a task ref from the yml stem", () => {
    expect(normaliseLabel(`${ROOT}/titan-platform/tasks/TP-84.yml`, ROOT).ref).toBe("task:TP-84");
  });

  it("gives a workspace file with no ref shape a relative path and no ref", () => {
    const label = normaliseLabel(`${ROOT}/titan-platform/brief.md`, ROOT);
    expect(label.relative).toBe("titan-platform/brief.md");
    expect(label.ref).toBeUndefined();
  });

  it("leaves a repo file with neither, since no retriever can name it", () => {
    const label = normaliseLabel("/Users/x/projects/titan-platform/README.md", ROOT);
    expect(label).toEqual({ absolute: "/Users/x/projects/titan-platform/README.md" });
  });

  it("does not mistake a deeper sources path for a source ref", () => {
    expect(normaliseLabel(`${ROOT}/p/sources/research/deep/a.md`, ROOT).ref).toBeUndefined();
  });
});

describe("dedupeLabels", () => {
  it("keeps the first occurrence and its order", () => {
    const labels = dedupeLabels([{ absolute: "/a" }, { absolute: "/b" }, { absolute: "/a" }]);
    expect(labels.map((label) => label.absolute)).toEqual(["/a", "/b"]);
  });
});
