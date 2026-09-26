import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseArgs, registerLayer, stampPackageDir, stampReferencePage } from "./new-package.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** A root with only the two paths stampReferencePage touches: the template and the pages. */
function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), "new-package-"));
  mkdirSync(join(root, "templates"), { recursive: true });
  mkdirSync(join(root, "site", "reference"), { recursive: true });
  cpSync(join(REPO, "templates", "reference-page.md"), join(root, "templates", "reference-page.md"));
  return root;
}

const baseCheck = JSON.stringify({
  rules: [
    {
      id: "package-layers",
      type: "layered-deps",
      $tiers: { 0: ["packages/store-sqlite"], 1: ["packages/registry"], 2: [], ui: [], product: [] },
      layers: [["packages/store-sqlite"], ["packages/registry"]],
    },
  ],
});

const layeredRule = (text) => JSON.parse(text).rules[0];

describe("new-package argument parsing", () => {
  it("accepts a kebab-case name with a known tier", () => {
    expect(parseArgs(["locator", "--tier", "0", "--description", "byte offsets"])).toMatchObject({
      name: "locator",
      tier: "0",
      description: "byte offsets",
    });
  });

  it("rejects a name that is not kebab-case", () => {
    expect(() => parseArgs(["StoreSqlite", "--tier", "0"])).toThrow(/invalid package name/);
  });

  it("rejects an unknown tier", () => {
    expect(() => parseArgs(["locator", "--tier", "7"])).toThrow(/--tier must be one of/);
  });
});

describe("registering a package in the layered-deps rule", () => {
  it("appends the package to its tier and to the matching layer", () => {
    const rule = layeredRule(registerLayer(baseCheck, "packages/locator", "0"));
    expect(rule.$tiers[0]).toEqual(["packages/store-sqlite", "packages/locator"]);
    expect(rule.layers[0]).toEqual(["packages/store-sqlite", "packages/locator"]);
  });

  it("skips empty tiers when deriving layers so codewatch accepts the rule", () => {
    const rule = layeredRule(registerLayer(baseCheck, "products/session-miner", "product"));
    expect(rule.$tiers.product).toEqual(["products/session-miner"]);
    expect(rule.layers).toEqual([["packages/store-sqlite"], ["packages/registry"], ["products/session-miner"]]);
  });

  it("keeps a higher tier above a newly filled lower tier", () => {
    const withProduct = registerLayer(baseCheck, "products/session-miner", "product");
    const rule = layeredRule(registerLayer(withProduct, "packages/session-read", "2"));
    expect(rule.layers.map((l) => l[0])).toEqual([
      "packages/store-sqlite",
      "packages/registry",
      "packages/session-read",
      "products/session-miner",
    ]);
  });

  it("registers into the $tiers rule when another layered-deps rule comes first", () => {
    const seam = { id: "seam", type: "layered-deps", layers: [["packages/a/src/x"], ["packages/a/src"]] };
    const config = JSON.parse(baseCheck);
    const withSeamFirst = JSON.stringify({ rules: [seam, ...config.rules] });
    const rules = JSON.parse(registerLayer(withSeamFirst, "packages/locator", "0")).rules;
    expect(rules[0]).toEqual(seam);
    expect(rules[1].$tiers[0]).toEqual(["packages/store-sqlite", "packages/locator"]);
  });

  it("does not duplicate a package that is already registered", () => {
    const rule = layeredRule(registerLayer(baseCheck, "packages/store-sqlite", "0"));
    expect(rule.$tiers[0]).toEqual(["packages/store-sqlite"]);
  });
});

describe("stamping the reference page the docs build demands", () => {
  const opts = { name: "beacon", tier: "1", description: "signals a thing", task: "TP-99" };

  it("writes site/reference/<name>.md with the placeholders filled in", () => {
    const root = fakeRoot();
    expect(stampReferencePage(root, opts)).toBe(join(root, "site", "reference", "beacon.md"));
    const page = readFileSync(join(root, "site", "reference", "beacon.md"), "utf8");
    expect(page).toContain("# beacon");
    expect(page).toContain("**Tier 1.**");
    expect(page).toContain("signals a thing");
    expect(page).toContain("Tracked by TP-99");
    expect(page).not.toMatch(/__[A-Z]+__/);
  });

  it("leaves an existing page alone so a re-stamp cannot flatten hand-written prose", () => {
    const root = fakeRoot();
    const page = join(root, "site", "reference", "beacon.md");
    writeFileSync(page, "# beacon\n\nhand-written\n");
    expect(stampReferencePage(root, opts)).toBeNull();
    expect(readFileSync(page, "utf8")).toBe("# beacon\n\nhand-written\n");
  });
});

describe("stamping the package directory", () => {
  it("gives the new package a CAPABILITY.md naming it, so the capability catalog can list it", () => {
    const root = mkdtempSync(join(tmpdir(), "new-package-"));
    cpSync(join(REPO, "templates", "package"), join(root, "templates", "package"), { recursive: true });
    const { dest } = stampPackageDir(root, { name: "beacon", tier: "1", description: "signals a thing", task: "TP-99" });
    const capability = readFileSync(join(dest, "CAPABILITY.md"), "utf8");
    expect(capability).toContain("# beacon: use this when");
    expect(capability).not.toMatch(/__[A-Z]+__/);
  });
});
