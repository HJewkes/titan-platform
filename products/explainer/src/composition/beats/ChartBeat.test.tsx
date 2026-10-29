import assert from "node:assert/strict";
import { Beat, MotionProvider, seekClock } from "@titan-design/react-ui/motion";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, test } from "vitest";
import { BEAT_SLOTS } from "../../beat-slots.js";
import { ChartKindBeat } from "./ChartBeat.js";
import { revealFrom } from "./stage/reveal.js";

/** Parcels sorted per hour at three synthetic depots. */
const DEPOTS = [
  { id: "north", label: "North", value: 40 },
  { id: "east", label: "East", value: 70 },
  { id: "south", label: "South", value: 100 },
];

/** Every bar has finished growing well before this beat-local second. */
const SETTLED_S = 8;

function drawChart(slots: Record<string, unknown>, at: { t?: number; reveals?: Parameters<typeof revealFrom>[0] } = {}): string {
  const parsed = BEAT_SLOTS.chart.parse({ series: DEPOTS, ...slots });
  return renderToStaticMarkup(
    <MotionProvider clock={seekClock(at.t ?? SETTLED_S)}>
      <Beat startS={0} durationS={10}>
        <ChartKindBeat slots={parsed} reveal={revealFrom(at.reveals ?? [])} hints={{}} />
      </Beat>
    </MotionProvider>,
  );
}

const barWidths = (html: string): string[] => [...html.matchAll(/class="ex-bar-fill" style="width:([\d.]+)%/g)].map((m) => m[1]!);
const columnHeights = (html: string): string[] => [...html.matchAll(/class="beat-graph-bar" style="height:([\d.]+)px/g)].map((m) => m[1]!);

describe("a chart drawn from its frame slots", () => {
  test("a line chart's columns rise from its baseline, which the axis names", () => {
    const html = drawChart({ kind: "line", baseline: 20 });

    assert.deepEqual(columnHeights(html), ["105", "262.5", "420"]);
    assert.match(html, /data-axis-floor="20"/);
  });

  test("bars on a negative baseline grow from that baseline, not from zero", () => {
    const html = drawChart({ kind: "bar", baseline: -20 });

    assert.deepEqual(barWidths(html), ["50", "75", "100"]);
    assert.match(html, /data-axis-floor="-20"/);
  });

  test("a chart with no frame fields draws from zero with no axis mark, legend or scale colour", () => {
    const html = drawChart({ kind: "bar" });

    assert.deepEqual(barWidths(html), ["40", "70", "100"]);
    assert.doesNotMatch(html, /ex-axis-origin|ex-chart-legend|background:#/);
  });

  test("a bar chart of ten or more rows packs its rows dense, and nine rows keep the full row", () => {
    const depots = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `depot-${i + 1}`, label: `Depot ${i + 1}`, value: 30 + 10 * i }));

    const dense = (count: number) => /class="ex-bars" data-dense="true"/.test(drawChart({ kind: "bar", series: depots(count) }));

    assert.deepEqual([9, 10, 12].map(dense), [false, true, true]);
  });

  test("a bar with a cue of its own stays empty until its cue while the bars before it grow", () => {
    const reveals = [{ target: "north", atS: 1 }, { target: "south", atS: 5 }];

    const early = barWidths(drawChart({ kind: "bar" }, { t: 4, reveals }));
    const late = barWidths(drawChart({ kind: "bar" }, { t: SETTLED_S, reveals }));

    assert.deepEqual(early, ["40", "70", "0"]);
    assert.deepEqual(late, ["40", "70", "100"]);
  });

  test("a broken axis draws the break mark at the origin", () => {
    const html = drawChart({ kind: "line", baseline: 30, axisBreak: true });

    assert.match(html, /class="ex-axis-break"/);
  });

  test("a sequential scale colours each bar by its value, low to high", () => {
    const html = drawChart({ kind: "bar", scale: { kind: "sequential", colours: ["#deebf7", "#9ecae1", "#3182bd"] } });

    const fills = [...html.matchAll(/class="ex-bar-fill" style="[^"]*background:(#[0-9a-f]{6})/g)].map((m) => m[1]);
    assert.deepEqual(fills, ["#deebf7", "#9ecae1", "#3182bd"]);
  });

  test("a diverging scale centres its middle colour on the baseline", () => {
    const html = drawChart({ kind: "line", baseline: 70, scale: { kind: "diverging", colours: ["#ca0020", "#f7f7f7", "#0571b0"] } });

    const fills = [...html.matchAll(/class="beat-graph-bar" style="[^"]*background:(#[0-9a-f]{6})/g)].map((m) => m[1]);
    assert.deepEqual(fills, ["#ca0020", "#f7f7f7", "#0571b0"]);
  });

  test("a legend names every series beside its colour", () => {
    const html = drawChart({ kind: "bar", legend: true, scale: { kind: "sequential", colours: ["#deebf7", "#3182bd"] } });

    const entries = [...html.matchAll(/class="ex-chart-legend-swatch" style="background:(#[0-9a-f]{6})"><\/span>(\w+)</g)].map((m) => `${m[2]} ${m[1]}`);
    assert.deepEqual(entries, ["North #deebf7", "East #3182bd", "South #3182bd"]);
  });
});
