import { describe, expect, it } from "vitest";
import { classifyPath } from "./path-class.js";

describe("classifyPath with the default config", () => {
  it.each([
    "src/queue.test.ts",
    "packages/ledger/src/entry.spec.tsx",
    "packages/ledger/src/entry.test.mutations.json",
    "src/__tests__/queue.ts",
    "src/__fixtures__/plan.json",
    "test/golden/help.txt",
    "src/__fixtures__/notes.md",
  ])("reads %s as test material", (path) => {
    expect(classifyPath(path)).toBe("test");
  });

  it.each([
    "pnpm-lock.yaml",
    "packages/ledger/package-lock.json",
    "yarn.lock",
    "bun.lockb",
    ".changeset/quiet-owls.md",
    "README.md",
    "site/guides/intro.md",
  ])("ignores %s", (path) => {
    expect(classifyPath(path)).toBe("ignored");
  });

  it.each(["src/queue.ts", "package.json", "packages/ledger/src/index.ts", "src/testing.ts", ".github/workflows/ci.yml"])(
    "reads %s as production",
    (path) => {
      expect(classifyPath(path)).toBe("production");
    },
  );
});

describe("classifyPath with repo-listed generated files", () => {
  it("ignores a generated file the repo lists and keeps unlisted siblings as production", () => {
    const config = { generatedGlobs: ["site/.vitepress/reference-sidebar.json"] };

    expect(classifyPath("site/.vitepress/reference-sidebar.json", config)).toBe("ignored");
    expect(classifyPath("site/.vitepress/config.ts", config)).toBe("production");
  });

  it("treats the generated file as production when the repo lists nothing", () => {
    expect(classifyPath("site/.vitepress/reference-sidebar.json")).toBe("production");
  });
});
