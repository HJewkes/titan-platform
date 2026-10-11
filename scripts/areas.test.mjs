import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { deriveAreas, loadAreas, renderAreaSection, replaceAreaSection, writeAreas } from "./areas.mjs";
import { areasReminder } from "./new-package.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(REPO, "scripts", "fixtures", "areas", "categories.yml");

const tempDirs = [];
afterAll(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function fixtureCopy() {
  const dir = mkdtempSync(join(tmpdir(), "areas-"));
  tempDirs.push(dir);
  const file = join(dir, "categories.yml");
  copyFileSync(FIXTURE, file);
  return file;
}

const tiers = { 0: ["packages/locator"], 2: ["packages/pm"], ui: ["packages/react-app"], product: ["apps/console"] };
const external = [{ id: "relay", tier: "product" }];

describe("area derivation", () => {
  it("names each $tiers path by its basename, with numeric tiers as numbers, then the external products", () => {
    expect(deriveAreas(tiers, external)).toEqual([
      { id: "locator", tier: 0, path: "packages/locator" },
      { id: "pm", tier: 2, path: "packages/pm" },
      { id: "react-app", tier: "ui", path: "packages/react-app" },
      { id: "console", tier: "product", path: "apps/console" },
      { id: "relay", tier: "product" },
    ]);
  });

  it("covers every $tiers entry in this repo plus the five external products", () => {
    const check = JSON.parse(readFileSync(join(REPO, ".codewatch", "check.json"), "utf8"));
    const paths = Object.values(check.rules[0].$tiers).flat();
    const areas = loadAreas(REPO);
    expect(areas.filter((area) => area.path).map((area) => area.path).sort()).toEqual([...paths].sort());
    expect(areas.filter((area) => !area.path).map((area) => area.id)).toEqual([
      "active-work",
      "agent-chat",
      "relay",
      "shepherd",
      "titan-design",
    ]);
  });

  it("renders a section that parses back to the same entries", () => {
    const areas = deriveAreas(tiers, external);
    expect(parse(renderAreaSection(areas))).toEqual({ area: areas });
  });
});

describe("area section replacement", () => {
  const section = renderAreaSection(deriveAreas(tiers, external));

  it("replaces only the area block and keeps every other byte of the file", () => {
    const original = readFileSync(FIXTURE, "utf8");
    const [before] = original.split("area:\n");
    const after = original.slice(original.indexOf("\n# introduces cos"));
    expect(replaceAreaSection(original, section)).toBe(`${before}${section}\n${after}`);
  });

  it("appends an area block to a registry that has none", () => {
    expect(replaceAreaSection("kind:\n  - epic\n", "area: []")).toBe("kind:\n  - epic\narea: []\n");
    expect(replaceAreaSection("kind: [epic]", "area: []")).toBe("kind: [epic]\narea: []\n");
  });

  it("replaces an area block at the end of the file and keeps the final newline", () => {
    expect(replaceAreaSection("kind: [epic]\narea:\n- id: x\n  tier: 0\n", "area: []")).toBe("kind: [epic]\narea: []\n");
  });
});

describe("area registry write", () => {
  it("writes the derived areas into a registry file that pm accepts", async () => {
    const file = fixtureCopy();
    const areas = deriveAreas(tiers, external);
    await writeAreas(file, areas);
    const written = parse(readFileSync(file, "utf8"));
    expect(written.area).toEqual(areas);
    expect(written.cos).toEqual(["standard", "fixed"]);
  });

  it("refuses to write a registry pm rejects and leaves the file unchanged", async () => {
    const file = fixtureCopy();
    await expect(writeAreas(file, [{ id: "Bad_Id", tier: 0 }])).rejects.toThrow(/not be a valid category registry/);
    expect(readFileSync(file, "utf8")).toBe(readFileSync(FIXTURE, "utf8"));
  });
});

describe("new:package areas reminder", () => {
  it("points the new package's area at the areas script", () => {
    expect(areasReminder("widget")).toContain("pnpm areas --write <categories.yml>");
    expect(areasReminder("widget")).toContain("`widget`");
  });
});
