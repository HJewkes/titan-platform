import { Beat, MotionProvider, seekClock } from "@titan-design/react-ui/motion";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BEAT_SLOTS } from "../../beat-slots.js";
import { ArchMapKindBeat } from "./ArchMapBeat.js";
import { ListFrame } from "./ListBeat.js";
import { EmphasisContext, litFrom } from "./stage/emphasis.js";
import { revealFrom } from "./stage/reveal.js";
import { FLOW_DWELL_S } from "./stage/video.js";

const CUE_S = 3;
const BEAT_S = 8;

function htmlAt(t: number, emphases: { target: string; atS: number }[], view: ReactElement): string {
  return renderToStaticMarkup(
    <MotionProvider clock={seekClock(t)}>
      <Beat startS={0} durationS={BEAT_S}>
        <EmphasisContext value={litFrom(emphases)}>{view}</EmphasisContext>
      </Beat>
    </MotionProvider>,
  );
}

/** The inline style of the element whose `data-reveal` is `id`. */
const styleOf = (html: string, id: string): string => new RegExp(`data-reveal="${id}"[^>]*style="([^"]*)"`).exec(html)?.[1] ?? "";

/** How many lines draw edge `id`: its own, plus the brand stroke under it while lit. */
const edgeLines = (html: string, id: string): number => (new RegExp(`data-reveal="${id}">(.*?)</g>`).exec(html)?.[1] ?? "").split("<line").length - 1;

/** Synthetic: two rows of an invented night desk. */
const ROWS = [
  { id: "rows-1", text: "Two lanes", mark: "tick" as const, atS: 0 },
  { id: "rows-2", text: "Night crew", mark: "tick" as const, atS: 1 },
];

describe("a template lighting the element a cue names", () => {
  it("a row named again on a later cue lights for its dwell, and only that row", () => {
    // Arrange
    const emphases = [{ target: "rows-1", atS: CUE_S }];
    const list = <ListFrame heading="Desk" items={ROWS} />;

    // Act
    const before = htmlAt(CUE_S - 0.5, emphases, list);
    const during = htmlAt(CUE_S + FLOW_DWELL_S / 2, emphases, list);
    const after = htmlAt(CUE_S + FLOW_DWELL_S + 0.5, emphases, list);

    // Assert
    expect(styleOf(before, "rows-1")).not.toContain("box-shadow");
    expect(styleOf(during, "rows-1")).toContain("box-shadow");
    expect(styleOf(during, "rows-2")).not.toContain("box-shadow");
    expect(styleOf(after, "rows-1")).not.toContain("box-shadow");
  });

  it("an edge cue lights the hop it names when the map lists its edges out of path order", () => {
    // Arrange
    const stops = ["Desk", "Lanes", "Crew"];
    const slots = BEAT_SLOTS.map.parse({
      title: "Desk",
      nodes: stops.map((label, i) => ({ id: `nodes-${i + 1}`, label })),
      edges: [{ id: "edges-1", from: "nodes-2", to: "nodes-3" }, { id: "edges-2", from: "nodes-1", to: "nodes-2" }],
    });
    const reveal = revealFrom(stops.map((_, i) => ({ target: `nodes-${i + 1}`, atS: i * 0.5 })));
    const map = <ArchMapKindBeat slots={slots} reveal={reveal} hints={{}} />;

    // Act
    const html = htmlAt(CUE_S + FLOW_DWELL_S / 2, [{ target: "edges-1", atS: CUE_S }], map);

    // Assert
    expect(edgeLines(html, "edges-1")).toBe(2);
    expect(html.indexOf('data-reveal="edges-2"')).toBeLessThan(html.indexOf('data-reveal="edges-1"'));
  });

  it("an arch-map edge cue lights the edge, and the other edge stays as drawn", () => {
    // Arrange
    const stops = ["Desk", "Lanes", "Crew"];
    const slots = BEAT_SLOTS.map.parse({
      title: "Desk",
      nodes: stops.map((label, i) => ({ id: `nodes-${i + 1}`, label })),
      edges: stops.slice(1).map((_, i) => ({ id: `edges-${i + 1}`, from: `nodes-${i + 1}`, to: `nodes-${i + 2}` })),
    });
    const reveal = revealFrom(stops.map((_, i) => ({ target: `nodes-${i + 1}`, atS: i * 0.5 })));
    const map = <ArchMapKindBeat slots={slots} reveal={reveal} hints={{}} />;

    // Act
    const html = htmlAt(CUE_S + FLOW_DWELL_S / 2, [{ target: "edges-1", atS: CUE_S }], map);

    // Assert
    expect(edgeLines(html, "edges-1")).toBe(2);
    expect(edgeLines(html, "edges-2")).toBe(1);
  });
});
