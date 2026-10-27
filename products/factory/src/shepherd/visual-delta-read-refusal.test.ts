import { githubPort } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { HEAD, MERGE_BASE, SHOT, THRESHOLD, card, evidence, world } from "./visual-delta-read.test-helpers.js";

describe("the visual delta reader on what a PR commits", () => {
  it("refuses before decoding a PNG whose header declares more than maxPixels, or that is interlaced", async () => {
    const huge = card(true);
    new DataView(huge.buffer, huge.byteOffset).setUint32(16, 20_000);
    new DataView(huge.buffer, huge.byteOffset).setUint32(20, 20_000);
    const interlaced = card(true);
    interlaced[28] = 1;
    const shot = (head: Uint8Array) => githubPort(world([{ path: SHOT, status: "modified" }], { [`${MERGE_BASE}:${SHOT}`]: card(), [`${HEAD}:${SHOT}`]: head }).wire);

    const reasons = [await evidence(shot(huge), THRESHOLD), await evidence(shot(interlaced), THRESHOLD), await evidence(shot(card(true)), { ...THRESHOLD, maxPixels: 9_999 })].map(
      ({ record }) => record.visualDelta?.snapshots[0]?.reason,
    );

    expect(reasons).toEqual([`over ${16 * 1024 * 1024} pixels at ${HEAD}`, `interlaced at ${HEAD}`, `over 9999 pixels at ${MERGE_BASE}`]);
  });

  it("reads a file renamed into the snapshot paths as added, never pairing it with a base path it did not have", async () => {
    const IN = "ui/visual/s.spec.ts-snapshots/c--y-chromium-linux.png";

    const { record } = await evidence(githubPort(world([{ path: IN, previousPath: "ui/docs/c.png", status: "renamed" }]).wire), THRESHOLD);

    expect(record.visualDelta?.snapshots).toEqual([{ path: IN, component: "c", status: "added" }]);
  });
});
