import { describe, it, expect } from "vitest";
import {
  buildAliases,
  classifyRename,
  parseRenameOutput,
} from "./git-renames.js";

describe("parseRenameOutput", () => {
  it("returns empty for empty input", () => {
    expect(parseRenameOutput("")).toEqual([]);
  });

  it("ignores non-rename status entries", () => {
    const out = parseRenameOutput(
      ["A\tnew.ts", "M\tedited.ts", "D\tgone.ts"].join("\n"),
    );
    expect(out).toEqual([]);
  });

  it("parses R<num>\\told\\tnew lines", () => {
    const out = parseRenameOutput(
      ["R100\tsrc/old.ts\tsrc/new.ts", "R85\tlib/a.ts\tlib/b.ts"].join("\n"),
    );
    expect(out).toEqual([
      { oldPath: "src/old.ts", newPath: "src/new.ts", similarity: 100 },
      { oldPath: "lib/a.ts", newPath: "lib/b.ts", similarity: 85 },
    ]);
  });

  it("falls back to similarity=100 when the status has no number", () => {
    const out = parseRenameOutput("R\told.ts\tnew.ts");
    expect(out[0]!.similarity).toBe(100);
  });

  it("ignores blank and partial lines", () => {
    const out = parseRenameOutput(
      ["R100\tsrc/old.ts", "", "R90\ta.ts\tb.ts"].join("\n"),
    );
    expect(out.map((p) => p.newPath)).toEqual(["b.ts"]);
  });
});

describe("classifyRename", () => {
  it("calls same-directory renames 'rename'", () => {
    expect(classifyRename("src/foo.ts", "src/bar.ts")).toBe("rename");
  });

  it("calls cross-directory renames 'move'", () => {
    expect(classifyRename("src/foo.ts", "lib/foo.ts")).toBe("move");
    expect(classifyRename("src/foo.ts", "lib/bar.ts")).toBe("move");
  });
});

describe("buildAliases", () => {
  it("emits a file alias and a module alias per rename pair", () => {
    const aliases = buildAliases("/repo", [
      { oldPath: "src/old.ts", newPath: "src/new.ts", similarity: 95 },
    ]);
    expect(aliases).toEqual([
      { oldId: "src/old.ts", newId: "src/new.ts", reason: "rename" },
      { oldId: "src/old", newId: "src/new", reason: "rename" },
    ]);
  });

  it("uses 'move' when the directory changes", () => {
    const aliases = buildAliases("/repo", [
      { oldPath: "src/x.ts", newPath: "lib/x.ts", similarity: 100 },
    ]);
    expect(aliases.every((a) => a.reason === "move")).toBe(true);
  });

  it("dedupes when two pairs would produce the same old_id", () => {
    const aliases = buildAliases("/repo", [
      { oldPath: "src/x.ts", newPath: "src/y.ts", similarity: 90 },
      { oldPath: "src/x.ts", newPath: "src/z.ts", similarity: 70 },
    ]);
    expect(aliases.filter((a) => a.oldId === "src/x.ts")).toHaveLength(1);
    expect(aliases.filter((a) => a.oldId === "src/x")).toHaveLength(1);
  });
});
