import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng } from "@titan-design/png-delta";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeGh, HEAD, OTHER, png } from "./pr-visual-evidence.test-helpers.js";
import { partialFake } from "@titan-design/test-kit";
import type { FactoryContext } from "../context.js";
import { logFramesCommand } from "./log-frames-command.js";
import { writePrVisuals, writeRoundVisuals } from "./pr-visual-round.js";

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

describe("the log's pr-visual pairs (TP-6777)", () => {
  it("writes the changed pair into the folder it is given, with no pr-<n> level", async () => {
    const folder = join(dir, "log-frames", "octo", "design", "7");

    const visuals = await writePrVisuals(target, folder, fakeGh({ pairs: [[png(), png(100)]] }));

    expect((await readdir(folder)).sort()).toEqual(["0-button--s0@1280-after.png", "0-button--s0@1280-before.png", "manifest.json"]);
    expect(visuals.variantKeys).toEqual([join(folder, "0-button--s0@1280-before.png"), join(folder, "0-button--s0@1280-after.png")]);
    expect(visuals.failed).toBeUndefined();
  });

  it("states why no pair is shown, and marks only a failed read as worth trying again", async () => {
    const mismatch = await writePrVisuals(target, dir, fakeGh({ pairs: [[png(), png(100)]], manifest: { headSha: OTHER } }));
    const failed = await writePrVisuals(target, dir, { text: () => Promise.reject(new Error("socket hang up")), bytes: () => Promise.reject(new Error("unused")) });

    expect(mismatch).toMatchObject({ variantKeys: [], reason: "the artifact was captured for another PR or head" });
    expect(mismatch.failed).toBeUndefined();
    expect(failed).toMatchObject({ variantKeys: [], failed: true });
    expect(failed.reason).toMatch(/^the read failed: /);
  });

  it("refuses a folder that is not the log-frames folder of this PR", async () => {
    const ctx = partialFake<FactoryContext>({});

    const run = (folder: string) => logFramesCommand.run({ ...target, dir: folder }, ctx);

    await expect(run(join(dir, "elsewhere"))).rejects.toThrow(/log-frames\/<owner>\/<repo>\/<pr>/);
    await expect(run(join(dir, "log-frames", "octo", "design", "8"))).rejects.toThrow(/for this PR/);
  });
});
