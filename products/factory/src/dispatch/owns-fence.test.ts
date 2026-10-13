import { describe, expect, it } from "vitest";
import { outsideOwns } from "./owns-fence.js";

const OWNS = ["src/agents/burndown/collision.ts"];

describe("a slice PR against its owns", () => {
  it("reports nothing for a file the slice owns", () => {
    expect(outsideOwns(["src/agents/burndown/collision.ts"], OWNS)).toEqual([]);
  });

  it("allows a companion test in src/__tests__ named for the owned file", () => {
    expect(outsideOwns(["src/__tests__/burndown-collision.test.ts"], OWNS)).toEqual([]);
  });

  it("allows a test beside the owned file", () => {
    expect(outsideOwns(["src/agents/burndown/collision.test.ts"], OWNS)).toEqual([]);
  });

  it("reports a file outside the owns", () => {
    expect(outsideOwns(["src/agents/burndown/collision.ts", "src/agents/burndown/ledger.ts"], OWNS)).toEqual(["src/agents/burndown/ledger.ts"]);
  });

  it("reports a test that names no owned stem", () => {
    expect(outsideOwns(["src/__tests__/burndown-ledger.test.ts"], OWNS)).toEqual(["src/__tests__/burndown-ledger.test.ts"]);
  });

  it("allows a test named for a wildcard entry's dir, and reports one named for another", () => {
    const files = ["src/__tests__/burndown-owns-fence.test.ts", "src/__tests__/seats-owns.test.ts"];

    expect(outsideOwns(files, ["src/agents/burndown/*.ts"])).toEqual(["src/__tests__/seats-owns.test.ts"]);
  });

  it("does not stall a slice for the changeset and capabilities boilerplate it never declared", () => {
    expect(outsideOwns(["src/foo/a.ts", ".changeset/x.md", "CAPABILITIES.md", "src/bar/b.ts"], ["src/foo/**"])).toEqual(["src/bar/b.ts"]);
  });

  it("allows nested readmes, reference docs, goldens, api declarations and lockfiles without owns", () => {
    const files = ["pkg/README.md", "site/reference/cli.md", "golden/cli-help.txt", "pkg/api/index.d.ts", "pkg/pnpm-lock.yaml", "yarn.lock"];

    expect(outsideOwns(files, [])).toEqual([]);
  });

  it("still reports paths that only look like generated declarations or lockfiles", () => {
    const files = ["pkg/api/index.ts", "pkg/api/nested/deep.d.ts", "package-lock.json.bak", "my-package-lock.json", "pnpm-lock.yml"];

    expect(outsideOwns(files, ["pkg/src/a.ts"])).toEqual(files);
  });
});
