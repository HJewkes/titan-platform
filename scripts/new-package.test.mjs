import { describe, expect, it } from "vitest";
import { parseArgs, registerLayer } from "./new-package.mjs";

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

  it("does not duplicate a package that is already registered", () => {
    const rule = layeredRule(registerLayer(baseCheck, "packages/store-sqlite", "0"));
    expect(rule.$tiers[0]).toEqual(["packages/store-sqlite"]);
  });
});
