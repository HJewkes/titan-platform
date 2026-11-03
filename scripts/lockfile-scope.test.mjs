import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { testScope } from "./test-scope.mjs";

// The workspace base.yaml locks: factory -> mid -> store, and hub -> leaf. factory and leaf both use chalk.
const workspace = [
  { dir: "packages/store/", name: "@fx/store", deps: [] },
  { dir: "packages/mid/", name: "@fx/mid", deps: ["@fx/store", "left-pad"] },
  { dir: "products/factory/", name: "@fx/factory", deps: ["@fx/mid", "chalk"] },
  { dir: "packages/leaf/", name: "@fx/leaf", deps: ["chalk"] },
  { dir: "deploy/hub/", name: "@fx/hub", deps: ["@fx/leaf"] },
];

const fixture = (name) => readFileSync(new URL(`./fixtures/lockfile-scope/${name}.yaml`, import.meta.url), "utf8");
const base = fixture("base");
const scopeOf = (head, from = base) => testScope(["pnpm-lock.yaml"], workspace, () => ({ base: from, head }));

describe("a pnpm-lock.yaml change", () => {
  it("scopes a PR that adds one dependency to one package to that package and its dependents", () => {
    const scope = scopeOf(fixture("add-one-dep"));

    expect(scope).toEqual({ mode: "scoped", dirs: ["deploy/hub/", "packages/leaf/", "scripts/"] });
  });

  it("scopes a removed dependency to the package that dropped it, tracing the snapshots on the base side", () => {
    const scope = scopeOf(base, fixture("add-one-dep"));

    expect(scope).toEqual({ mode: "scoped", dirs: ["deploy/hub/", "packages/leaf/", "scripts/"] });
  });

  it("runs everything for a root devDependency change", () => {
    const head = base.replace("specifier: ^5.4.0\n        version: 5.4.0", "specifier: ^5.5.0\n        version: 5.5.0");

    expect(scopeOf(head)).toEqual({
      mode: "full",
      reason: "pnpm-lock.yaml: the root importer changed or reaches a changed entry",
    });
  });

  it("scopes a transitive bump to every importer that reaches it", () => {
    expect(scopeOf(fixture("shared-bump"))).toEqual({
      mode: "scoped",
      dirs: ["deploy/hub/", "packages/leaf/", "products/factory/", "scripts/"],
    });
  });

  it("runs everything for a transitive bump only the root's tooling reaches", () => {
    const head = base.replace("tinyspy@3.0.0: {}", "tinyspy@3.0.0:\n    optional: true");

    expect(scopeOf(head)).toEqual({
      mode: "full",
      reason: "pnpm-lock.yaml: the root importer changed or reaches a changed entry",
    });
  });

  it("traces a changed packages entry to its snapshot whatever that snapshot's peers", () => {
    const head = base.replace("sha512-fixture-vitest-3.0.0", "sha512-fixture-vitest-3.0.0-republished");

    expect(scopeOf(head)).toEqual({
      mode: "full",
      reason: "pnpm-lock.yaml: the root importer changed or reaches a changed entry",
    });
  });

  it("runs everything for a changed snapshot no importer reaches", () => {
    const head = `${base}\n  orphan@1.0.0: {}\n`;

    expect(scopeOf(head)).toEqual({ mode: "full", reason: "pnpm-lock.yaml: orphan@1.0.0 reaches no importer" });
  });

  it("runs everything when a side does not parse", () => {
    expect(scopeOf("importers: [unclosed")).toEqual({ mode: "full", reason: "pnpm-lock.yaml: a side does not parse" });
  });

  it("runs everything when a lockfile setting changes", () => {
    const head = base.replace("autoInstallPeers: true", "autoInstallPeers: false");

    expect(scopeOf(head)).toEqual({ mode: "full", reason: "pnpm-lock.yaml: settings changed" });
  });

  it("runs everything when an importer is no workspace member", () => {
    const head = base.replace("  packages/store: {}", "  packages/store: {}\n\n  packages/gone: {}");

    expect(scopeOf(head)).toEqual({
      mode: "full",
      reason: "pnpm-lock.yaml: importer packages/gone/ is not a workspace member",
    });
  });
});
