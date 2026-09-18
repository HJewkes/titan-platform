import { describe, it, expect } from "vitest";
import { shouldIncludeFile, getLanguageFromPath, isExcludedDir } from "./file-filter.js";

describe("shouldIncludeFile", () => {
  const languages = ["typescript", "python"];

  it("includes .ts files when typescript is requested", () => {
    expect(shouldIncludeFile("src/utils.ts", languages)).toBe(true);
  });

  it("includes .tsx files when typescript is requested", () => {
    expect(shouldIncludeFile("src/App.tsx", languages)).toBe(true);
  });

  it("includes .py files when python is requested", () => {
    expect(shouldIncludeFile("scripts/main.py", languages)).toBe(true);
  });

  it("excludes files with non-matching extensions", () => {
    expect(shouldIncludeFile("styles.css", languages)).toBe(false);
  });

  it("excludes node_modules", () => {
    expect(shouldIncludeFile("node_modules/foo/index.ts", languages)).toBe(false);
  });

  it("excludes vendor directories", () => {
    expect(shouldIncludeFile("vendor/lib/bar.ts", languages)).toBe(false);
  });

  it("excludes dist directories", () => {
    expect(shouldIncludeFile("dist/index.js", languages)).toBe(false);
  });

  it("excludes .min.js files", () => {
    expect(shouldIncludeFile("lib/bundle.min.js", languages)).toBe(false);
  });

  it("excludes generated files", () => {
    expect(shouldIncludeFile("src/__generated__/types.ts", languages)).toBe(false);
  });

  it("excludes .claude/ (agent worktrees, skills, hook configs)", () => {
    expect(
      shouldIncludeFile(
        ".claude/worktrees/agent-abc/packages/cli/src/index.ts",
        languages,
      ),
    ).toBe(false);
    expect(
      shouldIncludeFile(".claude/skills/foo/index.ts", languages),
    ).toBe(false);
  });

  it("excludes lock files", () => {
    expect(shouldIncludeFile("pnpm-lock.yaml", languages)).toBe(false);
  });

  it("excludes .d.ts declaration files", () => {
    expect(shouldIncludeFile("src/types.d.ts", languages)).toBe(false);
  });
});

describe("isExcludedDir", () => {
  it("prunes the excluded directory names a source walk should skip recursing into", () => {
    for (const d of ["node_modules", "dist", "build", ".git", ".next", "vendor", "coverage"]) {
      expect(isExcludedDir(d)).toBe(true);
    }
  });

  it("does not prune ordinary source directories", () => {
    for (const d of ["src", "packages", "lib", "server", "node_modules_helper"]) {
      expect(isExcludedDir(d)).toBe(false);
    }
  });

  it("matches the file-level exclusion (a pruned dir yields no included files)", () => {
    // The prune is a speedup that must change no output: any dir isExcludedDir
    // prunes must also be one shouldIncludeFile rejects a file under.
    for (const d of ["node_modules", "dist", ".git"]) {
      expect(isExcludedDir(d)).toBe(true);
      expect(shouldIncludeFile(`${d}/foo/index.ts`, ["typescript"])).toBe(false);
    }
  });
});

describe("getLanguageFromPath", () => {
  it("returns typescript for .ts", () => {
    expect(getLanguageFromPath("src/index.ts")).toBe("typescript");
  });

  it("returns typescript for .tsx", () => {
    expect(getLanguageFromPath("src/App.tsx")).toBe("typescript");
  });

  it("returns python for .py", () => {
    expect(getLanguageFromPath("main.py")).toBe("python");
  });

  it("returns null for unknown extensions", () => {
    expect(getLanguageFromPath("styles.css")).toBeNull();
  });
});
