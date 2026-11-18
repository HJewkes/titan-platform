import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng } from "@titan-design/png-delta";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeGh, HEAD, OTHER, png } from "./pr-visual-evidence.test-helpers.js";
import { writeRoundVisuals } from "./pr-visual-round.js";

const target = { repo: "octo/design", pr: 7, head: HEAD };
const wide = (): Buffer => encodePng({ width: 1, height: 1, rgba: new Uint8Array([128, 128, 128, 255]) });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pr-visual-round-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const pngsIn = async (): Promise<string[]> => (await readdir(join(dir, "pr-7"))).filter((name) => name.endsWith(".png")).sort();

describe("the pr-visual round shows only changed pairs (TP-6196)", () => {
  it("writes two files when one of three shots changed and counts the rest", async () => {
    const gh = fakeGh({ pairs: [[png(), png()], [png(), png(100)], [png(), png()]] });

    const visuals = await writeRoundVisuals(target, dir, gh);

    expect(await pngsIn()).toEqual(["1-button--s1@1280-after.png", "1-button--s1@1280-before.png"]);
    expect(visuals.variantKeys).toHaveLength(2);
    expect(visuals.line).toContain("3 shots, 1 changed, 2 unchanged not shown, 0 missing");
  });

  it("writes no pairs and says all shots were unchanged when every shot measures zero", async () => {
    const gh = fakeGh({ pairs: [[png(), png()], [png(), png()]] });

    const visuals = await writeRoundVisuals(target, dir, gh);

    expect(visuals.variantKeys).toEqual([]);
    expect(await pngsIn()).toEqual([]);
    expect(visuals.line).toContain("all shots were unchanged");
  });

  it("keeps a shot whose before and after sizes differ", async () => {
    const gh = fakeGh({ pairs: [[png(), wide()], [png(), png()]] });

    const visuals = await writeRoundVisuals(target, dir, gh);

    expect(await pngsIn()).toEqual(["0-button--s0@1280-after.png", "0-button--s0@1280-before.png"]);
    expect(visuals.line).toContain("2 shots, 1 changed, 1 unchanged not shown");
  });

  it("states the head-mismatch reason and writes nothing", async () => {
    const visuals = await writeRoundVisuals(target, dir, fakeGh({ pairs: [[png(), png(100)]], manifest: { headSha: OTHER } }));

    expect(visuals.variantKeys).toEqual([]);
    expect(visuals.line).toContain("the artifact was captured for another PR or head");
  });
});
