import { describe, expect, it } from "vitest";
import type { ChangedFile, PackageJsonChange } from "./config.js";
import { doorFacts, effectiveDoor, underDeclared, type DoorInput, type OneWayFact } from "./door.js";

function file(path: string, status: ChangedFile["status"] = "modified", previousPath?: string): ChangedFile {
  return { path, status, additions: 1, deletions: 1, ...(previousPath ? { previousPath } : {}) };
}

const manifest = { name: "@example/ledger", exports: { ".": "./dist/index.js", "./cli": "./dist/cli.js" }, bin: { ledger: "./dist/bin.js" } };

function manifestChange(head: Record<string, unknown> | undefined): PackageJsonChange {
  return { path: "packages/ledger/package.json", base: manifest, ...(head ? { head } : {}) };
}

describe("doorFacts: each one-way fact", () => {
  it.each<[string, DoorInput, OneWayFact[]]>([
    ["a migrations directory", { files: [file("src/store/migrations/0007-owner.sql", "added")] }, [{ kind: "migration", path: "src/store/migrations/0007-owner.sql" }]],
    ["a migration-named ts file", { files: [file("src/store/add-owner-migration.ts")] }, [{ kind: "migration", path: "src/store/add-owner-migration.ts" }]],
    ["a migration-named sql file", { files: [file("db/0003_migration.sql")] }, [{ kind: "migration", path: "db/0003_migration.sql" }]],
    ["a major changeset", { files: [], changesetBumps: ["patch", "major"] }, [{ kind: "major-changeset" }]],
    [
      "an authority-protected path",
      { files: [file(".github/workflows/ci.yml")], config: { protectedPaths: [".github/**"] } },
      [{ kind: "authority-path", path: ".github/workflows/ci.yml" }],
    ],
    [
      "a path renamed out of an authority-protected directory",
      { files: [file("docs/ci.yml", "renamed", ".github/workflows/ci.yml")], config: { protectedPaths: [".github/**"] } },
      [{ kind: "authority-path", path: ".github/workflows/ci.yml" }],
    ],
    [
      "a removed exports subpath",
      { files: [], packageJsons: [manifestChange({ ...manifest, exports: { ".": "./dist/index.js" } })] },
      [{ kind: "package-key-removed", path: "packages/ledger/package.json", detail: "exports ./cli" }],
    ],
    [
      "a renamed bin",
      { files: [], packageJsons: [manifestChange({ ...manifest, bin: { "ledger-cli": "./dist/bin.js" } })] },
      [{ kind: "package-key-removed", path: "packages/ledger/package.json", detail: "bin ledger" }],
    ],
    [
      "a renamed package",
      { files: [], packageJsons: [manifestChange({ ...manifest, name: "@example/ledger-kit" })] },
      [{ kind: "package-key-removed", path: "packages/ledger/package.json", detail: "name @example/ledger" }],
    ],
    [
      "a deleted stored-data file",
      { files: [file("src/store/schema.json", "removed")], config: { storedDataGlobs: ["src/store/**"] } },
      [{ kind: "stored-data-deleted", path: "src/store/schema.json" }],
    ],
    [
      "a stored-data file renamed away",
      { files: [file("src/old/schema.json", "renamed", "src/store/schema.json")], config: { storedDataGlobs: ["src/store/**"] } },
      [{ kind: "stored-data-deleted", path: "src/store/schema.json" }],
    ],
  ])("one-way on %s", (_name, input, facts) => {
    expect(doorFacts(input)).toEqual({ door: "one-way", facts });
  });
});

describe("doorFacts: two-way changes", () => {
  it.each<[string, DoorInput]>([
    ["an ordinary source edit", { files: [file("src/queue.ts")] }],
    ["minor and patch changesets", { files: [], changesetBumps: ["minor", "patch"] }],
    ["a protected-looking path with no protected list", { files: [file(".github/workflows/ci.yml")] }],
    ["an edited stored-data file", { files: [file("src/store/schema.json")], config: { storedDataGlobs: ["src/store/**"] } }],
    ["a deleted file outside stored data", { files: [file("src/old.ts", "removed")], config: { storedDataGlobs: ["src/store/**"] } }],
    ["an added exports subpath and bin", { files: [], packageJsons: [manifestChange({ ...manifest, exports: { ...manifest.exports, "./x": "./x.js" }, bin: { ...manifest.bin, x: "./x.js" } })] }],
    ["a new package.json", { files: [], packageJsons: [{ path: "packages/new/package.json", head: manifest }] }],
    ["exports moved from a string to the same root subpath", { files: [], packageJsons: [{ path: "p/package.json", base: { name: "p", exports: "./a.js" }, head: { name: "p", exports: { ".": { import: "./a.js" } } } }] }],
  ])("two-way on %s", (_name, input) => {
    expect(doorFacts(input)).toEqual({ door: "two-way", facts: [] });
  });
});

describe("doorFacts: removed manifests and string forms", () => {
  it("names every key a deleted package.json removes", () => {
    expect(doorFacts({ files: [], packageJsons: [manifestChange(undefined)] }).facts.map((fact) => fact.detail)).toEqual([
      "name @example/ledger",
      "exports .",
      "exports ./cli",
      "bin ledger",
    ]);
  });

  it("reads a string bin under the unscoped package name", () => {
    const change = { path: "package.json", base: { name: "@example/tool", bin: "./bin.js" }, head: { name: "@example/tool" } };

    expect(doorFacts({ files: [], packageJsons: [change] }).facts).toEqual([{ kind: "package-key-removed", path: "package.json", detail: "bin tool" }]);
  });

  it("lists facts from several rules in rule order", () => {
    const input: DoorInput = { files: [file("migrations/1.sql"), file(".github/x.yml")], changesetBumps: ["major"], config: { protectedPaths: [".github/**"] } };

    expect(doorFacts(input).facts.map((fact) => fact.kind)).toEqual(["migration", "major-changeset", "authority-path"]);
  });
});

describe("effectiveDoor and underDeclared", () => {
  it.each([
    ["one-way", "two-way", "one-way", false],
    ["two-way", "one-way", "one-way", true],
    ["two-way", "two-way", "two-way", false],
    ["one-way", "one-way", "one-way", false],
    [undefined, "one-way", "one-way", false],
    [undefined, "two-way", "two-way", false],
  ] as const)("declared %s, computed %s: effective %s, under-declared %s", (declared, computed, effective, under) => {
    expect(effectiveDoor(declared, computed)).toBe(effective);
    expect(underDeclared(declared, computed)).toBe(under);
  });
});
