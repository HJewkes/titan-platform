import { describe, expect, it } from "vitest";
import { closureDirs, lockedVersions, nativeBuildChanges, readWorkspace, touchedPaths, UNKNOWN_DIFF, workspaceDirs, type WorkspaceReader } from "./deploy-closure.js";

const WORKSPACE_YAML = 'packages:\n  - "packages/*"\n  - "products/*"\n  - "deploy/hub"\n  - "!packages/ignored"\n';

const manifest = (name: string, deps: Record<string, string> = {}, devDeps: Record<string, string> = {}): string =>
  JSON.stringify({ name, dependencies: deps, devDependencies: devDeps });

function fakeCheckout(): WorkspaceReader {
  const files: Record<string, string> = {
    "pnpm-workspace.yaml": WORKSPACE_YAML,
    "products/factory/package.json": manifest("@titan-design/factory", { "@titan-design/workflow": "workspace:^", zod: "^4.0.0" }),
    "products/other/package.json": manifest("@titan-design/other", { "@titan-design/charts": "workspace:^" }),
    "packages/workflow/package.json": manifest("@titan-design/workflow", { "@titan-design/store": "workspace:^" }),
    "packages/store/package.json": manifest("@titan-design/store", {}, { "@titan-design/testkit": "workspace:^" }),
    "packages/testkit/package.json": manifest("@titan-design/testkit"),
    "packages/charts/package.json": manifest("@titan-design/charts"),
    "deploy/hub/package.json": manifest("@titan-design/hub"),
  };
  const dirs: Record<string, string[]> = { packages: ["workflow", "store", "testkit", "charts", "no-manifest"], products: ["factory", "other"] };
  return { readFile: (path) => files[path], listDirs: (dir) => dirs[dir] ?? [] };
}

describe("workspace closure", () => {
  it("expands a trailing /* glob and keeps literal workspace dirs", () => {
    const dirs = workspaceDirs(WORKSPACE_YAML, (dir) => (dir === "products" ? ["factory"] : []));

    expect(dirs).toEqual(["products/factory", "deploy/hub"]);
  });

  it("walks dependencies and devDependencies transitively from the factory and leaves unrelated packages out", () => {
    const closure = closureDirs(readWorkspace(fakeCheckout()));

    expect(closure).toEqual(["packages/store", "packages/testkit", "packages/workflow", "products/factory"]);
  });

  it("is empty when the root package is not in the workspace", () => {
    expect(closureDirs(readWorkspace(fakeCheckout()), "@titan-design/missing")).toEqual([]);
  });
});

describe("touched paths", () => {
  const closure = ["packages/store", "packages/workflow", "products/factory"];

  it("keeps changes inside a closure package and drops changes to unrelated packages and docs", () => {
    const changed = ["products/factory/src/deploy.ts", "packages/charts/src/index.ts", "site/guides/factory.md", "packages/store-sqlite/src/open.ts"];

    expect(touchedPaths(changed, closure)).toEqual(["products/factory/src/deploy.ts"]);
  });

  it("counts the root build inputs, root tsconfigs included, but not a nested tsconfig outside the closure", () => {
    const changed = ["pnpm-lock.yaml", "package.json", "pnpm-workspace.yaml", ".npmrc", "tsconfig.base.json", "packages/charts/tsconfig.json"];

    expect(touchedPaths(changed, closure)).toEqual(["pnpm-lock.yaml", "package.json", "pnpm-workspace.yaml", ".npmrc", "tsconfig.base.json"]);
  });

  it("is empty for a diff that reaches nothing the factory build reads", () => {
    expect(touchedPaths(["README.md"], closure)).toEqual([]);
  });

  it("counts an unknown diff as touched", () => {
    expect(touchedPaths(undefined, closure)).toEqual([UNKNOWN_DIFF]);
  });
});

describe("native-build lockfile changes", () => {
  const lock = (sqlite: string, extra = ""): string =>
    `lockfileVersion: '9.0'\n\npackages:\n\n  better-sqlite3@${sqlite}:\n    resolution: {}\n${extra}\nsnapshots:\n\n  better-sqlite3@${sqlite}:\n    dependencies:\n      node-addon-api: 8.9.2\n`;

  it("reads each locked version of a package once, ignoring dependency lines", () => {
    expect(lockedVersions(lock("13.0.3"), "better-sqlite3")).toEqual(["13.0.3"]);
    expect(lockedVersions(lock("13.0.3"), "node-addon-api")).toEqual([]);
  });

  it("names a native package whose version changed", () => {
    expect(nativeBuildChanges(lock("13.0.3"), lock("13.1.0"))).toEqual(["better-sqlite3 13.0.3 -> 13.1.0"]);
  });

  it("ignores a lockfile change that leaves every native package alone", () => {
    expect(nativeBuildChanges(lock("13.0.3"), lock("13.0.3", "\n  zod@4.4.3:\n    resolution: {}\n"))).toEqual([]);
  });

  it("names a native package the target adds", () => {
    expect(nativeBuildChanges(undefined, lock("13.0.3"))).toEqual(["better-sqlite3 absent -> 13.0.3"]);
  });
});
