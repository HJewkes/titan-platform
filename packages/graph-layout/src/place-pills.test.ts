import { describe, expect, it } from "vitest";
import { placePills, type PillConfig, type PillScene, type PinSpec, type Rect } from "./place-pills.js";

const CONFIG: PillConfig = { gap: 8, keepOut: 0.83 };
const FRAME: Rect = { x: 0, y: 0, width: 1200, height: 675 };

const box = (id: string, x: number, y: number): { id: string; rect: Rect } => ({ id, rect: { x, y, width: 160, height: 60 } });
const labelOf = ({ id, rect }: { id: string; rect: Rect }) => ({ id: `${id}:label`, rect: { x: rect.x + 12, y: rect.y + 12, width: rect.width - 24, height: 24 } });
const pin = (id: string, anchor: string, width = 140, height = 32, rank = 0): PinSpec => ({ id, anchor, width, height, rank });
const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Three boxes in a row with an edge label in each gap and one under the middle box, where its first pill would go. */
const anchors = [box("web", 120, 160), box("api", 520, 160), box("store", 920, 160)];
const crowded: PillScene = {
  frame: FRAME,
  anchors,
  obstacles: [
    ...anchors.map(labelOf),
    { id: "web->api", rect: { x: 300, y: 176, width: 200, height: 28 } },
    { id: "api->store", rect: { x: 700, y: 176, width: 200, height: 28 } },
    { id: "api:edge-below", rect: { x: 540, y: 228, width: 120, height: 28 } },
  ],
};
const crowdedPins = [
  pin("api-1", "api", 200),
  pin("api-2", "api", 200),
  pin("api-3", "api", 120),
  pin("web-1", "web"),
  pin("web-2", "web", 220),
  pin("store-1", "store", 180),
];

describe("placePills", () => {
  it("puts a pill centred under its box when nothing is in the way", () => {
    const { placed } = placePills({ frame: FRAME, anchors: [box("a", 500, 100)], obstacles: [] }, [pin("p", "a")], CONFIG);

    expect(placed).toEqual([{ id: "p", anchor: "a", rect: { x: 510, y: 168, width: 140, height: 32 }, candidate: "below0" }]);
  });

  // catches: skipping the overlap check against obstacles or earlier pills
  it("never overlaps a box label, an edge label or another pill", () => {
    const { placed, dropped } = placePills(crowded, crowdedPins, CONFIG);

    expect(dropped).toEqual([]);
    const rects = placed.map((p) => p.rect);
    for (const [i, r] of rects.entries()) {
      expect(crowded.obstacles.filter((o) => overlaps(r, o.rect)).map((o) => o.id)).toEqual([]);
      expect(rects.filter((other, j) => j !== i && overlaps(r, other))).toEqual([]);
    }
  });

  // catches: testing against the full frame height instead of the keep-out line
  it("keeps a pill above the keep-out band, moving it over a box that sits low in the frame", () => {
    const low = box("low", 500, 470);

    const { placed } = placePills({ frame: FRAME, anchors: [low], obstacles: [] }, [pin("p", "low")], CONFIG);

    const rect = placed[0]?.rect as Rect;
    expect(rect.y + rect.height).toBeLessThanOrEqual(FRAME.height * CONFIG.keepOut);
    expect(placed[0]?.candidate).toBe("above0");
  });

  // catches: placing in input order instead of sorting by rank then id
  it("gives the same placement for shuffled pin order", () => {
    const reversed = [...crowdedPins].reverse();
    const interleaved = [...crowdedPins].sort((a, b) => a.width - b.width || b.id.localeCompare(a.id));

    const first = JSON.stringify(placePills(crowded, crowdedPins, CONFIG));

    expect(JSON.stringify(placePills(crowded, reversed, CONFIG))).toBe(first);
    expect(JSON.stringify(placePills(crowded, interleaved, CONFIG))).toBe(first);
  });

  // catches: a first-candidate fallback that draws a pill with no clear spot
  it("drops a pill with no clear spot and one whose anchor is not in the scene", () => {
    const a = box("a", 500, 300);
    const walled: PillScene = { frame: FRAME, anchors: [a], obstacles: [{ id: "wall", rect: { x: 0, y: 0, width: 1200, height: 675 } }] };

    const { placed, dropped } = placePills(walled, [pin("p", "a"), pin("q", "missing")], CONFIG);

    expect(placed).toEqual([]);
    expect(dropped).toEqual([
      { id: "p", reason: "no-spot" },
      { id: "q", reason: "no-anchor" },
    ]);
  });
});
