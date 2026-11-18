import { Beat, MotionProvider, seekClock } from "@titan-design/react-ui/motion";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BEAT_SLOTS } from "../../beat-slots.js";
import { revealFrom } from "./stage/reveal.js";
import { MetricsPanelKindBeat, ScorecardKindBeat } from "./ScorecardTable.js";

/** Synthetic: an invented depot's measures, one with no target, and calls on two invented lanes. */
const METRICS = [
  { id: "rows-1", measure: "Parcels per hour", today: "250", target: "300" },
  { id: "rows-2", measure: "Dock idle time", today: "12 min" },
];
const CALLS = [
  { id: "rows-1", label: "Sorting lane", call: "Ship", reason: "Throughput held all week" },
  { id: "rows-2", label: "Returns lane", call: "Hold" },
];

const REVEAL_AT_S = 2;

function metricsAt(t: number, reveals: { target: string; atS: number }[] = []): string {
  const slots = BEAT_SLOTS["metrics-panel"].parse({ rows: METRICS });
  return renderToStaticMarkup(
    <MotionProvider clock={seekClock(t)}>
      <Beat startS={0} durationS={6}>
        <MetricsPanelKindBeat slots={slots} reveal={revealFrom(reveals)} hints={{}} />
      </Beat>
    </MotionProvider>,
  );
}

function scorecardAt(t: number): string {
  const slots = BEAT_SLOTS.scorecard.parse({ rows: CALLS });
  return renderToStaticMarkup(
    <MotionProvider clock={seekClock(t)}>
      <Beat startS={0} durationS={6}>
        <ScorecardKindBeat slots={slots} reveal={revealFrom([])} hints={{}} />
      </Beat>
    </MotionProvider>,
  );
}

const revealIds = (html: string) => [...html.matchAll(/data-reveal="([^"]+)"/g)].map((m) => m[1]);

describe("a metrics panel drawn as a table", () => {
  it("draws one row per slot row, each carrying its reveal id", () => {
    // Act
    const html = metricsAt(4);

    // Assert
    expect(revealIds(html)).toEqual(["rows-1", "rows-2"]);
  });

  it("draws no target cell for a row with no target", () => {
    // Act
    const html = metricsAt(4);

    // Assert
    expect(html.match(/class="beat-table-target"/g)).toHaveLength(1);
    expect(html).toContain("300");
  });

  it("hides a row just before its reveal and shows it after, under seekClock", () => {
    // Arrange
    const reveals = [{ target: "rows-1", atS: REVEAL_AT_S }];
    const opacityOfFirstRow = (html: string) => /data-reveal="rows-1"[^>]*opacity:(\d)/.exec(html)?.[1];

    // Act
    const before = opacityOfFirstRow(metricsAt(REVEAL_AT_S - 0.05, reveals));
    const after = opacityOfFirstRow(metricsAt(REVEAL_AT_S + 1, reveals));

    // Assert
    expect([before, after]).toEqual(["0", "1"]);
  });
});

describe("a scorecard drawn as a table", () => {
  it("shows a row's reason beside its call", () => {
    // Act
    const html = scorecardAt(4);

    // Assert
    expect(html).toContain("Throughput held all week");
    expect(revealIds(html)).toEqual(["rows-1", "rows-2"]);
  });
});
