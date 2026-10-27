import type { Moment, ProbedMoment } from "@titan-design/render-qa";
import type { Stage } from "../anchor-grid.js";
import { clippedText, type MeasuredText } from "../clip-checks.js";
import { contentFillFindings } from "../content-fill.js";
import { anchorFindings, type QaFinding } from "../occupancy-checks.js";
import { buildOccupancy, type OccupancyTable } from "../occupancy-table.js";
import { emptyStageRuns, type StageMoment } from "../stage-empty-checks.js";
import type { MeasuredFinding } from "./qa-report.js";
import type { QaTimeline } from "./qa-timeline.js";

/** What the page-measured checks read: the moments QA sampled, the probe at each one in the same order, and the MP4's frame change. */
interface MeasuredInput {
  timeline: QaTimeline;
  moments: readonly Moment[];
  probed: readonly ProbedMoment[];
  diffs: readonly number[];
  fps: number;
  stage: Stage;
}

const stageMoment = (moment: ProbedMoment): StageMoment => ({ beat: moment.beat, t: moment.t, boxes: moment.boxes });

const measuredTexts = (moment: ProbedMoment): MeasuredText[] =>
  moment.texts.map(({ element, text, lines, clips }) => ({ beat: moment.beat, t: moment.t, element, text, lines, clips }));

const contentBoxes = (moment: ProbedMoment) => moment.boxes.filter((box) => !box.decor);

/** A beat whose frames never change from its first frame to its settled one: an identical frame at t and t + 0.5 fails. */
function motionFindings(timeline: QaTimeline, settled: readonly Moment[], diffs: readonly number[], fps: number): QaFinding[] {
  const settledAt = new Map(settled.map((moment) => [moment.beat, moment.t]));
  return timeline.beats.flatMap((beat): QaFinding[] => {
    const endT = settledAt.get(beat.id);
    const from = Math.round(beat.startS * fps);
    const to = endT === undefined ? from : Math.round(endT * fps);
    // The first frame's change is the cut from the beat before, not motion of this beat's own.
    if (to <= from || diffs.slice(from + 1, to + 1).some((share) => share > 0)) return [];
    const message = `${beat.id}: no frame changed from ${beat.startS.toFixed(2)} s to its settled sample at ${endT!.toFixed(2)} s`;
    return [{ code: "motion-happened", severity: "error", message, beat: beat.id, t: endT! }];
  });
}

/** Content-fill names every content element of its moment, so its anchors say where the narrow content sits. */
function fillFindings(settled: readonly ProbedMoment[], stage: Stage): QaFinding[] {
  return contentFillFindings(settled.map(stageMoment), stage).map((finding) => {
    const moment = settled.find((m) => m.beat === finding.beat && m.t === finding.t);
    return { ...finding, elements: moment ? contentBoxes(moment).map((box) => box.element) : [] };
  });
}

/** One DOM occupancy table per settled moment, keyed by the probe's element names, which the findings name too. */
function occupancy(settled: readonly ProbedMoment[], stage: Stage): OccupancyTable[] {
  const marks = settled.map((m) => ({ beat: m.beat, t: m.t, elements: contentBoxes(m).map((box) => ({ id: box.element, box: box.box })) }));
  return buildOccupancy({ stage, layouts: [], marks });
}

/**
 * The page-measured checks (TP-2610, TP-4105): motion between each beat's start and its settled sample, and at the
 * settled moments clipped text and content fill; an empty stage over every probed moment. Each finding carries the
 * anchor cells its elements sit on when the beat's occupancy table holds them, else the beat alone.
 */
export function measuredFindings(input: MeasuredInput): MeasuredFinding[] {
  const settledMoments = input.moments.filter((moment) => moment.kind === "end");
  const settled = input.probed.filter((_, i) => input.moments[i]?.kind === "end");
  const findings = [
    ...motionFindings(input.timeline, settledMoments, input.diffs, input.fps),
    ...clippedText(settled.flatMap(measuredTexts)),
    ...fillFindings(settled, input.stage),
    ...emptyStageRuns(input.probed.map(stageMoment), { x: 0, y: 0, ...input.stage }),
  ];
  return anchorFindings(findings, occupancy(settled, input.stage), input.stage).map((anchored, i) => {
    const { t } = findings[i]!;
    return { code: anchored.code, severity: anchored.severity, beat: anchored.beat, ...(t === undefined ? {} : { t }), anchors: anchored.anchors, message: anchored.message };
  });
}
