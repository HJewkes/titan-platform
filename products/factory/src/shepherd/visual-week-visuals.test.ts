import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BASE, fakeGh, png } from "./pr-visual-evidence.test-helpers.js";
import type { PrVisualGh } from "./pr-visual-evidence.js";
import { pairVisuals } from "./visuals-manifest.js";
import { NOW, REPO, headOf, notHeld, parked, world } from "./visual-week.test-helpers.js";
import { visualWeekWithVisuals } from "./visual-week-visuals.js";

const dirs: string[] = [];
const roundDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "visual-week-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** One artifact for PR 7 at its own head; every other head lists no artifact. */
function ghForPr7(): PrVisualGh {
  const head = headOf(7);
  const artifact = fakeGh({ pairs: [[png(), png(120)], [png(), png()]], runHead: head, manifest: { pr: 7, headSha: head, selected: [{ story: "button--s0", paths: [] }, { story: "card--s9", paths: [] }] } });
  return { ...artifact, text: async (args, ms) => (args.some((arg) => arg.includes(`pr-visual-${head}`)) || !args.includes("--paginate") ? artifact.text(args, ms) : "") };
}

const batchWith = async (dir: string, gh: PrVisualGh) => {
  const parts = [parked(7), parked(8)];
  return visualWeekWithVisuals({ repo: REPO, ...world(...parts), heldAt: notHeld, now: NOW }, dir, gh);
};

describe("the weekly batch with pr-visual pairs (TP-4761 C3)", () => {
  it("a visual-week batch carries before and after pairs for each PR with an artifact", async () => {
    const dir = await roundDir();

    const batch = await batchWith(dir, ghForPr7());

    const section = batch.sections!.find((item) => item.questionIds[0] === "pr-7")!;
    expect(section.context).toBe("pr-visual: 2 shots, 1 changed, 1 missing (unattested producer output; not used for the tier)");
    expect(section.variantKeys).toHaveLength(4);
    const paired = await pairVisuals(dir, 7, headOf(7));
    expect(paired).toMatchObject({ base: BASE, pairs: [{ story: "button--s0", width: "1280" }, { story: "button--s1", width: "1280" }] });
    expect(await readFile(section.variantKeys[1]!)).toEqual(png(120));
  });

  it("a PR with no artifact says why, never an after-only set", async () => {
    const dir = await roundDir();

    const batch = await batchWith(dir, ghForPr7());

    const section = batch.sections!.find((item) => item.questionIds[0] === "pr-8")!;
    expect(section.context).toBe("pr-visual: no before and after shown, no pr-visual artifact from the configured workflow at the head (unattested producer output; not used for the tier)");
    expect(section.variantKeys).toEqual([]);
    expect(await readdir(dir)).toEqual(["pr-7"]);
  });

  it("a shot with only an after image shows no pairs at all", async () => {
    const dir = await roundDir();
    const head = headOf(7);
    const shots = [{ story: "button--s0", width: "1280", after: "after/button--s0@1280.png" }];
    const gh = fakeGh({ pairs: [[png(), png()]], runHead: head, manifest: { pr: 7, headSha: head, shots } });

    const batch = await visualWeekWithVisuals({ repo: REPO, ...world(parked(7)), heldAt: notHeld, now: NOW }, dir, gh);

    expect(batch.sections![0]).toMatchObject({ context: expect.stringContaining("1 shot(s) lack a before or an after"), variantKeys: [] });
    expect(await readdir(dir)).toEqual([]);
  });

  it("an artifact captured at another head shows no pairs", async () => {
    const dir = await roundDir();
    const gh = fakeGh({ pairs: [[png(), png()]], runHead: headOf(7), manifest: { pr: 7, headSha: "f".repeat(40) } });

    const batch = await visualWeekWithVisuals({ repo: REPO, ...world(parked(7)), heldAt: notHeld, now: NOW }, dir, gh);

    expect(batch.sections![0]).toMatchObject({ context: expect.stringContaining("another PR or head"), variantKeys: [] });
    expect(await readdir(dir)).toEqual([]);
  });
});
