import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { renderSeatBook } from "@titan-design/coordinator";
import { importTree } from "./import.js";
import { FIXTURE_LIMITS, FIXTURE_TREE, copyFixtureTree, fixtureCharter, fixtureSeat } from "./test-tree.js";

function writeYamlSeat(tree: string, file: string, edit: (yaml: string) => string): void {
  writeFileSync(path.join(tree, file), `---\n${edit(stringify(fixtureSeat(tree, file)))}---\n\n# seat\n`);
}

function withCharter(tree: string, extra: Record<string, unknown>): void {
  const charter = fixtureCharter(tree);
  writeFileSync(path.join(tree, "charter.md"), `---\n${JSON.stringify({ ...charter, ...extra }, null, 2)}\n---\n`);
}

describe("importTree", () => {
  it("imports the coordinator package's example tree to a document that renders back to the same seat files", async () => {
    const seats = [fixtureSeat(FIXTURE_TREE, "seat-a.md"), fixtureSeat(FIXTURE_TREE, "seat-b.md")];

    const imported = await importTree(FIXTURE_TREE, { limits: FIXTURE_LIMITS });

    expect(imported.ok && renderSeatBook(imported.document)).toEqual(seats);
  });

  it("refuses a seat whose config_dir differs from its pool's, naming the file and the field", async () => {
    const limits = { ...FIXTURE_LIMITS, pools: { ...FIXTURE_LIMITS.pools, "pool-c": { config_dir: "/home/user/cfg/other", ceiling_five_hour: 90, reserve_seven_day: 20 } } };

    const imported = await importTree(FIXTURE_TREE, { limits });

    expect(imported).toEqual({ ok: false, errors: [expect.objectContaining({ file: "seat-b.md", path: "config_dir" })] });
  });

  it("builds limits from the charter's pools block, never the given ones, when the charter has one", async () => {
    const tree = copyFixtureTree();
    withCharter(tree, { pools: FIXTURE_LIMITS.pools });
    const given = { version: 1 as const, pools: {} };

    const imported = await importTree(tree, { limits: given });

    expect(imported.ok && [imported.limitsFrom, imported.document.limits]).toEqual(["charter", FIXTURE_LIMITS]);
  });

  it("refuses a charter pool the limits schema does not allow, naming the charter key", async () => {
    const tree = copyFixtureTree();
    withCharter(tree, { pools: { ...FIXTURE_LIMITS.pools, "pool-a": { ...FIXTURE_LIMITS.pools["pool-a"], ceiling_typo: 80 } } });

    const imported = await importTree(tree);

    expect(imported).toEqual({ ok: false, errors: [expect.objectContaining({ file: "charter.md", path: "pools.pool-a" })] });
  });

  it("refuses a charter with no pools block when no limits are given", async () => {
    const imported = await importTree(FIXTURE_TREE);

    expect(imported).toEqual({ ok: false, errors: [expect.objectContaining({ file: "charter.md", path: "pools" })] });
  });

  it("keeps each YAML comment in seats/*.md as a note naming the file and the key", async () => {
    const tree = copyFixtureTree();
    mkdirSync(path.join(tree, "seats"));
    for (const file of ["seat-a.md", "seat-b.md"]) renameSync(path.join(tree, file), path.join(tree, "seats", file));
    writeYamlSeat(tree, "seats/seat-a.md", (yaml) => yaml.replace("implementers: 4", "implementers: 4 # raised from 3, decision 101"));

    const imported = await importTree(tree, { limits: FIXTURE_LIMITS });

    expect(imported.ok && imported.notes).toEqual(["seats/seat-a.md: concurrency.implementers: raised from 3, decision 101"]);
    expect(imported.ok && imported.document.seats["seat-a"]?.concurrency.implementers).toBe(4);
  });

  it("skips a markdown file with no front matter or another schema, and names a seat file that fails the schema", async () => {
    const tree = copyFixtureTree();
    writeFileSync(path.join(tree, "notes.md"), "# notes\n");
    writeFileSync(path.join(tree, "queue.md"), "---\nschema: other/v1\n---\n");
    const skipped = await importTree(tree, { limits: FIXTURE_LIMITS });
    writeFileSync(path.join(tree, "seat-b.md"), readFileSync(path.join(tree, "seat-b.md"), "utf8").replace('"implementers": 2', '"implementers": -1'));

    const broken = await importTree(tree, { limits: FIXTURE_LIMITS });

    expect(skipped.ok && Object.keys(skipped.document.seats)).toEqual(["seat-a", "seat-b"]);
    expect(broken).toEqual({ ok: false, errors: [expect.objectContaining({ file: "seat-b.md", path: "concurrency.implementers" })] });
  });
});
