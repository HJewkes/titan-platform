import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { type Decoded, decodePngBounded } from "./png-bounded.js";
import { contentBox, pixelDelta, snapshotShare } from "./delta.js";

type Rgb = readonly [number, number, number];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

function frame(width: number, height: number, background: Rgb = WHITE): PNG {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) paint(image, x, y, background);
  return image;
}

function paint(image: PNG, x: number, y: number, [r, g, b]: Rgb): void {
  image.data.set([r, g, b, 255], (y * image.width + x) * 4);
}

function fill(image: PNG, x: number, y: number, size: number, colour: Rgb): PNG {
  for (let dy = 0; dy < size; dy += 1) for (let dx = 0; dx < size; dx += 1) paint(image, x + dx, y + dy, colour);
  return image;
}

/** Round-trips through the encoder and the bounded decoder, as a snapshot blob reaches the measure. */
function decode(image: PNG): Decoded {
  const decoded = decodePngBounded(PNG.sync.write(image), { maxPixels: 1 << 20 });
  if ("refused" in decoded) throw new Error(decoded.refused);
  return decoded;
}

/** A 100×100 white frame with a black 10×10 square at (20, 20), as a tight specimen crop sits in a story viewport. */
const squareInFrame = (): PNG => fill(frame(100, 100), 20, 20, 10, BLACK);

describe("snapshotShare", () => {
  it("gives 0 for identical images", () => {
    expect(snapshotShare(decode(squareInFrame()), decode(squareInFrame()))).toBe(0);
  });

  it("divides by the content box, so one changed pixel of a 10×10 square in a 100×100 frame is 0.01", () => {
    const head = squareInFrame();
    paint(head, 25, 25, [255, 0, 0]);

    expect(snapshotShare(decode(squareInFrame()), decode(head))).toBe(0.01);
  });

  it("gives 1 when the dimensions differ", () => {
    expect(snapshotShare(decode(frame(100, 100)), decode(frame(100, 101)))).toBe(1);
  });

  it("does not count an antialiased edge whose shade shifts", () => {
    const edge = (shade: number): PNG => {
      const image = fill(fill(frame(40, 40), 0, 0, 20, BLACK), 0, 20, 20, BLACK);
      for (let y = 0; y < 40; y += 1) paint(image, 20, y, [shade, shade, shade]);
      return image;
    };

    expect(snapshotShare(decode(edge(96)), decode(edge(160)))).toBe(0);
  });

  it("counts a change the default pixel tolerance would let pass when the tolerance is tighter", () => {
    const head = squareInFrame();
    paint(head, 25, 25, [12, 12, 12]);

    expect(snapshotShare(decode(squareInFrame()), decode(head))).toBe(0);
    expect(snapshotShare(decode(squareInFrame()), decode(head), { pixelTolerance: 0.01 })).toBe(0.01);
  });

  it("caps a background change at 1", () => {
    expect(snapshotShare(decode(squareInFrame()), decode(fill(frame(100, 100, BLACK), 20, 20, 10, WHITE)))).toBe(1);
  });
});

describe("contentBox", () => {
  it("bounds the pixels that differ from the corner colour across both images", () => {
    const moved = fill(frame(100, 100), 50, 60, 10, BLACK);

    expect(contentBox([decode(squareInFrame()), decode(moved)])).toEqual({ x: 20, y: 20, width: 40, height: 50 });
  });

  it("is null for blank frames", () => {
    expect(contentBox([decode(frame(10, 10)), decode(frame(10, 10, BLACK))])).toBeNull();
  });
});

describe("pixelDelta", () => {
  it("draws the moved pixels and gives their count and share", () => {
    const head = squareInFrame();
    paint(head, 25, 25, [255, 0, 0]);

    const delta = pixelDelta(decode(squareInFrame()), decode(head));

    expect(delta).toMatchObject({ sizesDiffer: false, changedPixels: 1, share: 0.01, image: { width: 100, height: 100 } });
    const changed = delta.sizesDiffer ? [] : [...delta.image.rgba.subarray((25 * 100 + 25) * 4, (25 * 100 + 25) * 4 + 3)];
    expect(changed).toEqual([255, 0, 0]);
  });

  it("counts nothing for identical images", () => {
    expect(pixelDelta(decode(squareInFrame()), decode(squareInFrame()))).toMatchObject({ changedPixels: 0, share: 0 });
  });

  it("says the sizes differ instead of drawing", () => {
    expect(pixelDelta(decode(frame(100, 100)), decode(frame(100, 101)))).toEqual({
      sizesDiffer: true,
      before: { width: 100, height: 100 },
      after: { width: 100, height: 101 },
    });
  });
});
