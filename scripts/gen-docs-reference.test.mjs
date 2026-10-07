import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collect } from "./gen-docs-reference.mjs";

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "gen-docs-reference-"));
  mkdirSync(join(root, ".codewatch"));
  const rule = { type: "layered-deps", $tiers: { 0: ["packages/alpha"], product: ["products/beta"] } };
  writeFileSync(join(root, ".codewatch", "check.json"), JSON.stringify({ rules: [rule] }));
  for (const group of ["packages", "products", "apps"]) mkdirSync(join(root, group));
  return root;
}

const writeManifest = (root, dir, text) => {
  mkdirSync(join(root, dir));
  writeFileSync(join(root, dir, "package.json"), text);
};

describe("collect", () => {
  it("skips entries without a package.json such as .gitkeep", () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "products", ".gitkeep"), "");
    writeManifest(root, "packages/alpha", JSON.stringify({ name: "@titan-design/alpha", version: "1.0.0" }));

    const names = collect(root).map((e) => e.name);

    expect(names).toContain("@titan-design/alpha");
  });

  it("throws naming the file when a package.json is malformed", () => {
    const root = fixtureRoot();
    writeManifest(root, "packages/alpha", "{ not json");

    expect(() => collect(root)).toThrow(/packages[/\\]alpha[/\\]package\.json/);
  });
});
