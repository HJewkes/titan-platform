import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MARKED_PAGES, collect, outputs, problems } from "./gen-docs-reference.mjs";

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

const MARKERS = {
  "site/guides/architecture.md": "<!-- generated:arch-graph start --><!-- generated:arch-graph end -->\n\n<!-- generated:arch-leaves start --><!-- generated:arch-leaves end -->\n\n<!-- generated:arch-products start --><!-- generated:arch-products end -->\n\nComposes <!-- generated:miner-count start -->ten<!-- generated:miner-count end --> packages.\n",
  "site/guides/index.md": "Case study: <!-- generated:miner-count start -->ten<!-- generated:miner-count end --> packages.\n",
};

const pkg = (name, deps = {}) => JSON.stringify({ name: `@titan-design/${name}`, version: "1.0.0", dependencies: deps });

function siteRoot(tiers, families) {
  const root = mkdtempSync(join(tmpdir(), "gen-docs-site-"));
  mkdirSync(join(root, ".codewatch"));
  writeFileSync(join(root, ".codewatch", "check.json"), JSON.stringify({ rules: [{ type: "layered-deps", $tiers: tiers }] }));
  for (const dir of ["packages", "products", "apps", "site/reference", "site/guides", "site/.vitepress"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  for (const page of Object.keys(MARKED_PAGES)) writeFileSync(join(root, page), MARKERS[page]);
  writeFileSync(join(root, "site/guides/package-families.md"), families);
  writeFileSync(join(root, "site/reference/react-ui.md"), "");
  return root;
}

function addPackage(root, dir, deps) {
  writeManifest(root, dir, pkg(dir.split("/")[1], deps));
  writeFileSync(join(root, "site/reference", `${dir.split("/")[1]}.md`), "");
}

function workspaceWithNewUnit() {
  const root = siteRoot(
    { 0: ["packages/alpha"], 1: ["packages/fresh-unit"], product: ["products/session-miner"] },
    "`alpha` and `fresh-unit`",
  );
  addPackage(root, "packages/alpha");
  addPackage(root, "packages/fresh-unit", { "@titan-design/alpha": "workspace:^" });
  const miner = { name: "@titan-design/session-miner", private: true, dependencies: {
    "@titan-design/alpha": "workspace:^",
    "@titan-design/fresh-unit": "workspace:^",
  } };
  writeManifest(root, "products/session-miner", JSON.stringify(miner));
  return root;
}

const page = (root, path) => outputs(root).find((o) => o.path === path).content;

describe("architecture page generation", () => {
  it("draws a unit added to $tiers as a node in its tier with its dependency edges", () => {
    const root = workspaceWithNewUnit();

    const text = page(root, "site/guides/architecture.md");

    expect(text).toMatch(/subgraph T1\["Tier 1 · engines"\]\n {4}freshUnit\["fresh-unit"\]\n {2}end/);
    expect(text).toContain("  freshUnit --> alpha\n");
    expect(text).toContain("  sessionMiner --> freshUnit\n");
  });

  it("lists only packages without titan dependencies as standalone, and counts products and miner deps", () => {
    const root = workspaceWithNewUnit();

    const text = page(root, "site/guides/architecture.md");

    expect(text).toContain("\n`alpha` have no titan dependencies at all");
    expect(text).toContain("The `product` tier holds one unit: `session-miner`.");
    expect(text).toContain("Composes <!-- generated:miner-count start -->two<!-- generated:miner-count end --> packages.");
    expect(page(root, "site/guides/index.md")).toContain("start -->two<!--");
  });

  it("reports a package that has no family on the families page", () => {
    const root = workspaceWithNewUnit();
    for (const { path, content } of outputs(root)) writeFileSync(join(root, path), content);
    writeFileSync(join(root, "site/guides/package-families.md"), "`alpha` only");

    expect(problems(root)).toEqual([expect.stringMatching(/^No package family for: fresh-unit\./)]);
  });

  it("reports a committed page that differs from the generated text as stale", () => {
    const root = workspaceWithNewUnit();
    for (const { path, content } of outputs(root)) writeFileSync(join(root, path), content);
    expect(problems(root)).toEqual([]);

    writeManifest(root, "packages/beta", pkg("beta"));
    writeFileSync(join(root, ".codewatch", "check.json"), JSON.stringify({ rules: [{ type: "layered-deps", $tiers: {
      0: ["packages/alpha", "packages/beta"], 1: ["packages/fresh-unit"], product: ["products/session-miner"],
    } }] }));
    writeFileSync(join(root, "site/reference/beta.md"), "");
    writeFileSync(join(root, "site/guides/package-families.md"), "`alpha`, `beta` and `fresh-unit`");

    expect(problems(root)).toEqual([expect.stringMatching(/out of date: .*site\/reference\/index\.md, site\/guides\/architecture\.md\./)]);
  });

  it("fails naming the page when its generated markers are gone", () => {
    const root = workspaceWithNewUnit();
    writeFileSync(join(root, "site/guides/index.md"), "no markers here\n");

    expect(() => outputs(root)).toThrow(/site\/guides\/index\.md has no <!-- generated:miner-count/);
  });
});
