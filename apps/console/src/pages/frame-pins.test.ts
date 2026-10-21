import { describe, expect, it } from "vitest";
import { describeTarget, isTap, nextPinId, pngSurface, pointerPin, type Pin } from "./frame-pins.js";

const pin = (id: string): Pin => ({ id, width: 375, x: 0, y: 0, xPct: 0, yPct: 0, note: "" });

describe("pointerPin", () => {
  it("measures a press on a frame shown at half size in the frame's own px, with shares rounded to 4 places", () => {
    const surface = pngSurface({ viewportWidth: 375 }, { width: 750, height: 1334 });
    if (!surface) throw new Error("no surface");

    const placed = pointerPin({ clientX: 110, clientY: 75 }, { left: 10, top: 20, width: 187.5 }, surface);

    expect(placed).toEqual({ width: 375, x: 200, y: 110, xPct: 0.5333, yPct: 0.1649 });
  });

  it("keeps a press on the frame's far edge inside 0..1", () => {
    const surface = pngSurface({}, { width: 300, height: 200 });
    if (!surface) throw new Error("no surface");

    expect(pointerPin({ clientX: 300, clientY: 200 }, { left: 0, top: 0, width: 300 }, surface)).toMatchObject({ xPct: 1, yPct: 1 });
  });
});

describe("pngSurface", () => {
  it("measures in the viewport width first, then the frameReference width, then the PNG's own pixels", () => {
    const natural = { width: 2560, height: 1600 };

    expect(pngSurface({ viewportWidth: 1280, referenceWidth: 1440 }, natural)).toMatchObject({ width: 1280, height: 800 });
    expect(pngSurface({ referenceWidth: 1440 }, natural)).toMatchObject({ width: 1440, height: 900 });
    expect(pngSurface({}, natural)).toMatchObject({ width: 2560, height: 1600 });
  });

  it("has no surface before the image has a size, and no element under any point", () => {
    expect(pngSurface({ viewportWidth: 375 }, { width: 0, height: 0 })).toBeUndefined();
    expect(pngSurface({}, { width: 10, height: 10 })?.hitTest(1, 1)).toBeUndefined();
  });
});

describe("nextPinId", () => {
  it("never hands out a removed pin's number again", () => {
    expect(nextPinId("card", [pin("card-1"), pin("card-3")], 3)).toBe("card-4");
    expect(nextPinId("card", [pin("card-1"), pin("card-2")], 3)).toBe("card-4");
    expect(nextPinId("card", [], 0)).toBe("card-1");
  });

  it("reads the number after the frame's own key, whose name may hold dashes", () => {
    expect(nextPinId("default-375-light", [pin("default-375-light-2")], 0)).toBe("default-375-light-3");
  });
});

describe("isTap", () => {
  it("takes a press that moved 8 px as a tap and one that moved 20 px as a scroll", () => {
    expect(isTap({ clientX: 0, clientY: 0 }, { clientX: 8, clientY: 0 })).toBe(true);
    expect(isTap({ clientX: 0, clientY: 0 }, { clientX: 0, clientY: 20 })).toBe(false);
  });
});

describe("describeTarget", () => {
  it("reads coordinates only without a target, and the element's test id, role and text with one", () => {
    expect(describeTarget(undefined)).toBe("coordinates only");
    expect(describeTarget({ testId: "save", role: "button", text: "Save" })).toBe('#save button "Save"');
  });
});
