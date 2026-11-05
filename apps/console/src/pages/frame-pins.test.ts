import { describe, expect, it } from "vitest";
import { describeTarget, hitBox, isTap, nextPinId, pinsDrawnAt, pngSurface, pngWidth, pointerPin, type Pin, type TargetBox } from "./frame-pins.js";

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

describe("pngWidth", () => {
  it("takes the declared widths before the PNG's pixels, and has none while it declares none and has not loaded", () => {
    expect(pngWidth({ viewportWidth: 390, referenceWidth: 1440 }, undefined)).toBe(390);
    expect(pngWidth({ referenceWidth: 1440 }, { width: 2880 })).toBe(1440);
    expect(pngWidth({}, { width: 2880 })).toBe(2880);
    expect(pngWidth({}, { width: 0 })).toBeUndefined();
  });
});

describe("pinsDrawnAt", () => {
  const at = (id: string, width?: number) => ({ id, ...(width !== undefined && { width }) });

  it("keeps the pins placed at the render's width and those with no width, dropping another width's", () => {
    expect(pinsDrawnAt([at("a-1", 390), at("a-2", 1440), at("a-3")], 390).map((pin) => pin.id)).toEqual(["a-1", "a-3"]);
  });

  it("keeps every pin while the render's width is not known", () => {
    expect(pinsDrawnAt([at("a-1", 390), at("a-2", 1440)], undefined)).toHaveLength(2);
  });
});

describe("hitBox", () => {
  const card: TargetBox = { x: 10, y: 10, width: 200, height: 100, target: { testId: "card" } };
  const save: TargetBox = { x: 150, y: 70, width: 50, height: 30, target: { testId: "save", role: "button" } };

  it("picks the inner of two nested boxes, wherever it is listed", () => {
    expect(hitBox([card, save], 160, 80)).toEqual({ testId: "save", role: "button" });
    expect(hitBox([save, card], 160, 80)).toEqual({ testId: "save", role: "button" });
    expect(hitBox([card, save], 20, 20)).toEqual({ testId: "card" });
  });

  it("gives undefined outside every box, including just past a box's far edge", () => {
    expect(hitBox([card, save], 5, 5)).toBeUndefined();
    expect(hitBox([card, save], 210, 50)).toBeUndefined();
    expect(hitBox([], 0, 0)).toBeUndefined();
  });
});

describe("a PNG surface with an element map", () => {
  const boxes: TargetBox[] = [{ x: 100, y: 0, width: 100, height: 50, target: { testId: "dot" } }];

  it("records the element under a press in the viewport's px", () => {
    const surface = pngSurface({ viewportWidth: 320 }, { width: 640, height: 360 }, boxes);
    if (!surface) throw new Error("no surface");

    expect(pointerPin({ clientX: 75, clientY: 10 }, { left: 0, top: 0, width: 160 }, surface)).toMatchObject({ x: 150, y: 20, target: { testId: "dot" } });
  });

  it("stays coordinates only on a frame with no viewport width, whose px are not the boxes' px", () => {
    expect(pngSurface({ referenceWidth: 320 }, { width: 640, height: 360 }, boxes)?.hitTest(150, 20)).toBeUndefined();
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
