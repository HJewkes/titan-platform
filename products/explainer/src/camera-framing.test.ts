import { describe, expect, it } from "vitest";
import type { CameraSample } from "./camera.js";
import { keyBoxRows, revealRows } from "./camera-framing.js";

const FRAME = { x: 0, y: 0, width: 1600, height: 900 };
const still = (ts: number[], box = FRAME): CameraSample[] => ts.map((t) => ({ t, box }));

describe("camera framing key boxes", () => {
  const key = { id: "api", box: { x: 400, y: 200, width: 400, height: 200 }, fromS: 1, toS: 3 };

  it("passes a key held in frame for its whole window", () => {
    const rows = keyBoxRows(still([0, 1, 2, 3, 4]), [key]);

    expect(rows).toEqual([]);
  });

  it("fails a key that dips into the caption band at its sample time", () => {
    const track = [...still([1, 2]), { t: 2.5, box: { ...FRAME, y: -500 } }, ...still([3])];

    const rows = keyBoxRows(track, [key]);

    expect(rows).toEqual([{ rule: "camera:key-in-frame", t: 2.5, id: "api" }]);
  });

  it("fails a key pushed past the frame's left edge", () => {
    const track = [{ t: 1, box: { ...FRAME, x: 600 } }];

    expect(keyBoxRows(track, [key])).toEqual([{ rule: "camera:key-in-frame", t: 1, id: "api" }]);
  });

  it("ignores samples outside the key's window", () => {
    const track = [{ t: 0.5, box: { ...FRAME, y: -900 } }, { t: 3.5, box: { ...FRAME, y: -900 } }];

    expect(keyBoxRows(track, [key])).toEqual([]);
  });

  it("passes a key whose bottom edge sits exactly on the caption line", () => {
    const edge = { id: "edge", box: { x: 0, y: 0, width: 1600, height: 747 }, fromS: 0, toS: 1 };

    expect(keyBoxRows(still([0]), [edge])).toEqual([]);
  });
});

describe("camera framing reveals", () => {
  const reveal = { id: "db", box: { x: 2000, y: 100, width: 300, height: 200 }, atS: 4 };

  it("passes a reveal object that stays off-frame until its cue", () => {
    const track = [...still([0, 3]), { t: 4, box: { ...FRAME, x: 1500 } }];

    expect(revealRows(track, [reveal])).toEqual([]);
  });

  it("fails a reveal object fully framed a second early", () => {
    const track = [...still([0]), { t: 3, box: { ...FRAME, x: 1500 } }];

    expect(revealRows(track, [reveal])).toEqual([{ rule: "camera:seen-before-reveal", t: 3, id: "db" }]);
  });

  it("passes a reveal object only partly in frame before its cue", () => {
    const track = [{ t: 3, box: { ...FRAME, x: 500 } }];

    expect(revealRows(track, [reveal])).toEqual([]);
  });
});
