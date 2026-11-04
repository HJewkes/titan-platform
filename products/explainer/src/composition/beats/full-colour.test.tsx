import { Beat, MotionProvider, seekClock } from "@titan-design/react-ui/motion";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BEAT_SLOTS } from "../../beat-slots.js";
import { BarChartFrame } from "./BarChartBeat.js";
import { GraphFrame } from "./GraphBeat.js";
import { HookBeat } from "./hook.js";
import { ListFrame } from "./ListBeat.js";
import { OutroKindBeat } from "./OutroBeat.js";
import { StatKindBeat } from "./StatBeat.js";
import { revealFrom } from "./stage/reveal.js";

const BEAT_S = 6;
/** The sweep samples this early into a beat; an entrance caught mid-fade here is read as low contrast. */
const FIRST_FRAME_S = 0.1;
const LAST_FRAME_S = BEAT_S - 0.1;
const MID_FADE = /opacity:\s*0\.\d/;

/** Synthetic: an invented depot's parcels, with every cue at the start of the beat so each entrance is under way at 0.1 s. */
const STAT = BEAT_SLOTS.stat.parse({ figures: [{ id: "figures-1", label: "Parcels scanned", value: 250 }] });
const HOOK = BEAT_SLOTS.hook.parse({ line: "Parcels arrive late", cards: [{ id: "cards-1", text: "Every Monday" }] });
const OUTRO = BEAT_SLOTS.outro.parse({ line: "See you at the depot" });
const ROWS = [{ id: "rows-1", label: "North", value: 12 }, { id: "rows-2", label: "South", value: 7 }];
const POINTS = [{ id: "points-1", label: "Mon", value: 4, litAtS: 0 }, { id: "points-2", label: "Tue", value: 9, litAtS: 0 }];
const ITEMS = [{ id: "items-1", text: "Sort", atS: 0, mark: "tick" as const }];

const TEMPLATES: Record<string, { view: ReactElement; atS: number }[]> = {
  StatBeat: [{ view: <StatKindBeat slots={STAT} reveal={revealFrom([])} hints={{}} />, atS: FIRST_FRAME_S }],
  /** A bar's value starts rising 0.36 s into its grow, so 0.5 s catches it mid-entrance. */
  BarChartBeat: [{ view: <BarChartFrame rows={ROWS} growAtS={0} />, atS: FIRST_FRAME_S }, { view: <BarChartFrame rows={ROWS} growAtS={0} />, atS: 0.5 }],
  GraphBeat: [{ view: <GraphFrame points={POINTS} growAtS={0} />, atS: FIRST_FRAME_S }],
  hook: [{ view: <HookBeat slots={HOOK} />, atS: FIRST_FRAME_S }, { view: <HookBeat slots={HOOK} />, atS: LAST_FRAME_S }],
  "ListBeat heading exit": [{ view: <ListFrame heading="Steps" items={ITEMS} headingYieldsAtS={0.4} />, atS: FIRST_FRAME_S }, { view: <ListFrame heading="Steps" items={ITEMS} headingYieldsAtS={0.4} />, atS: 0.3 }],
  OutroBeat: [{ view: <OutroKindBeat slots={OUTRO} reveal={revealFrom([])} hints={{}} />, atS: FIRST_FRAME_S }, { view: <OutroKindBeat slots={OUTRO} reveal={revealFrom([])} hints={{}} />, atS: LAST_FRAME_S }],
};

function htmlAt(view: ReactElement, t: number): string {
  return renderToStaticMarkup(
    <MotionProvider clock={seekClock(t)}>
      <Beat startS={0} durationS={BEAT_S}>{view}</Beat>
    </MotionProvider>,
  );
}

describe("a template's text entering or leaving", () => {
  it.each(Object.entries(TEMPLATES))("%s is at full colour on its sampled early and late frames", (_name, samples) => {
    for (const { view, atS } of samples) {
      // Arrange
      const sample = atS;

      // Act
      const html = htmlAt(view, sample);

      // Assert
      expect(html).toContain("style=");
      expect(html).not.toMatch(MID_FADE);
    }
  });
});
