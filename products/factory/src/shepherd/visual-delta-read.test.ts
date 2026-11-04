import { describe, expect, it } from "vitest";
import { evidenceComment } from "./evidence-comment.js";
import { MergeEvidenceSchema, VisualDeltaSchema } from "./review-schemas.js";
import { MERGE_BASE, SHOT, THRESHOLD, changedShot, evidence, world } from "./visual-delta-read.test-helpers.js";

describe("the merge evidence under shepherd.visualThreshold shadow", () => {
  it("measures a changed snapshot's share from the merge base to the head", async () => {
    const fake = changedShot();

    const { record } = await evidence(fake, THRESHOLD);

    expect(record.visualDelta?.snapshots).toEqual([{ path: SHOT, component: "card", status: "changed", share: 0.01 }]);
    expect(record.visualDelta?.mergeBase).toBe(MERGE_BASE);
    expect(record.visualDelta?.policy).toEqual({ mode: "shadow", maxChangedShare: 0.01, pixelTolerance: 0.1 });
    expect(fake.calls.filter((call) => call === "getContentBytes" || call === "compareFiles")).toEqual(["compareFiles", "getContentBytes", "getContentBytes"]);
  });

  it("records nothing when the repo's mode is off or the repo has no threshold", async () => {
    const [off, none] = [await evidence(changedShot(), { ...THRESHOLD, mode: "off" }), await evidence(changedShot())];

    expect([off.record.visualDelta, none.record.visualDelta]).toEqual([undefined, undefined]);
  });

  it("reads a snapshot renamed into the snapshot paths as added, and one renamed out of them as removed", async () => {
    const files = [
      { path: SHOT, previousPath: "ui/docs/card.png", status: "renamed" },
      { path: "ui/docs/b.png", previousPath: "ui/visual/s.spec.ts-snapshots/b--x-chromium-linux.png", status: "renamed" },
    ];

    const { record } = await evidence(world(files), THRESHOLD);

    expect(record.visualDelta?.snapshots.map((s) => [s.component, s.status])).toEqual([["b", "removed"], ["card", "added"]]);
  });

  it("keeps the evidence comment under 60,000 characters when a PR regenerates hundreds of snapshots, counting what it leaves out", async () => {
    const long = "x".repeat(400);
    const shot = (i: number) => `ui/visual/stories.spec.ts-snapshots/${long}-${i}--default-chromium-linux.png`;
    // 100 of each is past both caps and, uncapped, well over the limit; 400 each ran past vitest's timeout on CI.
    const added = Array.from({ length: 100 }, (_, i) => ({ path: shot(i), status: "added" }));
    const reports = Array.from({ length: 100 }, (_, i) => ({ path: `ui/api/${long}-${i}.api.md`, status: "modified" }));
    const files = [...added, { path: shot(999), status: "removed" }, ...reports];

    const { record } = await evidence(world(files), THRESHOLD);

    expect(evidenceComment(record).length).toBeLessThan(60_000);
    expect(record.visualDelta?.omitted).toEqual({ snapshots: 61, api: 80 });
    expect(record.visualDelta?.snapshots[0]?.status).toBe("removed");
  });

  it("matches the public API, token and harness paths, a token test aside", async () => {
    const files = [{ path: "ui/api/index.api.md", status: "modified" }, { path: "ui/src/theme/config.ts", status: "modified" }, { path: "ui/src/theme/config.test.ts", status: "modified" }, { path: "ui/playwright.config.ts", status: "modified" }];

    const { record } = await evidence(world(files), THRESHOLD);

    expect([record.visualDelta?.api, record.visualDelta?.tokens, record.visualDelta?.harness]).toEqual([["ui/api/index.api.md"], ["ui/src/theme/config.ts"], ["ui/playwright.config.ts"]]);
  });

  it("leaves the decision as it is without the threshold, and keeps a record the evidence schema reads", async () => {
    const [shadow, none] = [await evidence(changedShot(), THRESHOLD), await evidence(changedShot())];

    expect(shadow.record.decision).toEqual(none.record.decision);
    expect(MergeEvidenceSchema.parse(shadow).record.visualDelta?.snapshots[0]?.share).toBe(0.01);
  });
});

describe("VisualDeltaSchema", () => {
  const recorded = { policy: { mode: "shadow", maxChangedShare: 0.01, pixelTolerance: 0.1 }, mergeBase: null, snapshots: [], api: [], tokens: [], harness: [] };
  const snapshot = (path: string) => ({ path, component: "card", status: "added" });

  it("refuses a delta with more than 40 snapshots or a string over 300 characters, so an unbounded writer fails at the parse", () => {
    const forty = Array.from({ length: 40 }, (_, i) => snapshot(`s${i}.png`));

    expect(VisualDeltaSchema.safeParse({ ...recorded, snapshots: forty }).success).toBe(true);
    expect(VisualDeltaSchema.safeParse({ ...recorded, snapshots: [...forty, snapshot("s40.png")] }).success).toBe(false);
    expect(VisualDeltaSchema.safeParse({ ...recorded, snapshots: [snapshot("p".repeat(300))] }).success).toBe(true);
    expect(VisualDeltaSchema.safeParse({ ...recorded, snapshots: [snapshot("p".repeat(301))] }).success).toBe(false);
    expect(VisualDeltaSchema.safeParse({ ...recorded, api: Array.from({ length: 21 }, (_, i) => `a${i}.api.md`) }).success).toBe(false);
  });
});
