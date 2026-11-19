import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  buildAliases,
  classifyRename,
  detectRenames,
} from "./git-renames.js";

describe("detectRenames", () => {
  it("reports the real path of a renamed non-ASCII file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "renames-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir });
      git("init", "-q");
      mkdirSync(path.join(dir, "src"));
      writeFileSync(path.join(dir, "src", "caf\u00e9.ts"), "export const a = 1;\nexport const b = 2;\n");
      git("add", "-A");
      git("commit", "-q", "-m", "one");
      git("mv", "src/caf\u00e9.ts", "src/na\u00efve.ts");
      git("commit", "-q", "-m", "two");
      expect(detectRenames({ repoRoot: dir, fromCommit: "HEAD~1", toCommit: "HEAD" })).toEqual([
        { oldPath: "src/caf\u00e9.ts", newPath: "src/na\u00efve.ts" },
      ]);
      const aliases = buildAliases(dir, detectRenames({ repoRoot: dir, fromCommit: "HEAD~1", toCommit: "HEAD" }));
      expect(aliases[0]).toMatchObject({ oldId: "src/caf\u00e9.ts", newId: "src/na\u00efve.ts" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      { oldPath: "src/old.ts", newPath: "src/new.ts" },
    ]);
    expect(aliases).toEqual([
      { oldId: "src/old.ts", newId: "src/new.ts", reason: "rename" },
      { oldId: "src/old", newId: "src/new", reason: "rename" },
    ]);
  });

  it("uses 'move' when the directory changes", () => {
    const aliases = buildAliases("/repo", [
      { oldPath: "src/x.ts", newPath: "lib/x.ts" },
    ]);
    expect(aliases.every((a) => a.reason === "move")).toBe(true);
  });

  it("dedupes when two pairs would produce the same old_id", () => {
    const aliases = buildAliases("/repo", [
      { oldPath: "src/x.ts", newPath: "src/y.ts" },
      { oldPath: "src/x.ts", newPath: "src/z.ts" },
    ]);
    expect(aliases.filter((a) => a.oldId === "src/x.ts")).toHaveLength(1);
    expect(aliases.filter((a) => a.oldId === "src/x")).toHaveLength(1);
  });
});
