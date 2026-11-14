import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Track } from "../arms.js";
import { itemVerdicts } from "./judgments.js";
import { loadRun, type RunData } from "./load.js";
import { renderReport } from "./markdown.js";
import { MAX_ROUTING_HALF_WIDTH, MIN_ROUTING_BLOCKS, ROUTING_MARGIN, routingTable, type RoutedTrack, type RoutingRow } from "./routing.js";
import { trackContext, type TrackReport } from "./track.js";
import { implementSolved, implementTrack } from "./track-i.js";
import { planScore, planTrack } from "./track-p.js";
import { reviewCatch, reviewTrack } from "./track-r.js";

const REPORT_SCHEMA = "titan.bench-report/v1";

export interface ReportOptions {
  runs: Partial<Record<Track, string>>;
  partial: boolean;
  targets: Partial<Record<Track, number>>;
}

interface CostLedgers {
  arm: Partial<Record<Track, number>>;
  judge: Partial<Record<Track, number>>;
  totals: { arm: number; judge: number; all: number };
}

interface TrackReports {
  r?: ReturnType<typeof reviewTrack>;
  i?: ReturnType<typeof implementTrack>;
  p?: ReturnType<typeof planTrack>;
}

export interface Report {
  schema: typeof REPORT_SCHEMA;
  partial: boolean;
  completeBlocks: Partial<Record<Track, number>>;
  targets: Partial<Record<Track, number>>;
  tracks: TrackReports;
  routing: RoutingRow[];
  cost: CostLedgers;
  rules: { minRoutingBlocks: number; maxRoutingHalfWidth: number; margins: typeof ROUTING_MARGIN };
}

type Runs = Partial<Record<Track, RunData>>;

function routed(runs: Runs) {
  const of = (track: Track, metric: (run: RunData) => RoutedTrack["metric"], margin: number): RoutedTrack | undefined => {
    const run = runs[track];
    return run === undefined ? undefined : { ctx: trackContext(run), metric: metric(run), margin };
  };
  return {
    review: of("r", () => reviewCatch, ROUTING_MARGIN.review),
    implement: of("i", () => implementSolved, ROUTING_MARGIN.implement),
    plan: of("p", (run) => planScore(itemVerdicts(run, "p")), ROUTING_MARGIN.plan),
  };
}

export const presentTracks = (tracks: TrackReports): TrackReport[] => [tracks.r, tracks.i, tracks.p].filter((report): report is NonNullable<typeof report> => report !== undefined);

function costLedgers(tracks: TrackReports): CostLedgers {
  const reports = presentTracks(tracks);
  const arm = Object.fromEntries(reports.map((report) => [report.track, report.armUsd]));
  const judge = Object.fromEntries(reports.map((report) => [report.track, report.judgeUsd]));
  const armTotal = reports.reduce((sum, report) => sum + report.armUsd, 0);
  const judgeTotal = reports.reduce((sum, report) => sum + report.judgeUsd, 0);
  return { arm, judge, totals: { arm: armTotal, judge: judgeTotal, all: armTotal + judgeTotal } };
}

function loadRuns(options: ReportOptions): Runs {
  const runs: Runs = {};
  for (const track of ["r", "i", "p"] as const) {
    const dir = options.runs[track];
    if (dir !== undefined) runs[track] = loadRun(track, dir);
  }
  return runs;
}

export function buildReport(options: ReportOptions): Report {
  const runs = loadRuns(options);
  const tracks: TrackReports = {
    ...(runs.r !== undefined && { r: reviewTrack(runs.r) }),
    ...(runs.i !== undefined && { i: implementTrack(runs.i) }),
    ...(runs.p !== undefined && { p: planTrack(runs.p) }),
  };
  const completeBlocks: Partial<Record<Track, number>> = Object.fromEntries(presentTracks(tracks).map((report) => [report.track, report.blocks.complete.length]));
  const belowTarget = (["r", "i", "p"] as const).some((track) => {
    const target = options.targets[track];
    return target !== undefined && (completeBlocks[track] ?? 0) < target;
  });
  return {
    schema: REPORT_SCHEMA,
    partial: options.partial || belowTarget,
    completeBlocks,
    targets: options.targets,
    tracks,
    routing: routingTable(routed(runs)),
    cost: costLedgers(tracks),
    rules: { minRoutingBlocks: MIN_ROUTING_BLOCKS, maxRoutingHalfWidth: MAX_ROUTING_HALF_WIDTH, margins: ROUTING_MARGIN },
  };
}

/** Writes `report.json` and the `REPORT.md` skeleton; returns the report. */
export function writeReport(options: ReportOptions, outDir: string): Report {
  const report = buildReport(options);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, "REPORT.md"), renderReport(report));
  return report;
}
