import { describe, expect, it } from "vitest";
import { touchedPaths } from "./build-closure.js";

describe("touchedPaths", () => {
  const closure = ["apps/console", "packages/daemon"];

  it("keeps root inputs and runtime files inside the closure", () => {
    const changed = ["pnpm-lock.yaml", "packages/daemon/src/x.ts", "apps/console/a.tsx"];
    expect(touchedPaths(changed, closure)).toEqual(changed);
  });

  it("drops tests, specs, markdown and files outside the closure", () => {
    const changed = ["packages/daemon/src/x.test.ts", "packages/daemon/y.spec.mts", "packages/daemon/README.md", "packages/other/src/z.ts", "packages/daemon-extra/z.ts"];
    expect(touchedPaths(changed, closure)).toEqual([]);
  });

  it("treats only root-level manifests and tsconfigs as root inputs", () => {
    const changed = ["tsconfig.base.json", ".npmrc", "pnpm-workspace.yaml", "x/package.json", "tsconfig/x.json", "README.md"];
    expect(touchedPaths(changed, [])).toEqual(["tsconfig.base.json", ".npmrc", "pnpm-workspace.yaml"]);
  });

  it("keeps nothing for an empty closure but still keeps root inputs", () => {
    expect(touchedPaths(["package.json", "a/b.ts"], [])).toEqual(["package.json"]);
  });
});
