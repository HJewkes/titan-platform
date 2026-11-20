import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { Box, CameraSample } from "./camera.js";
import { keyBoxRows, revealRows } from "./camera-framing.js";
import { cameraMotionRows } from "./camera-motion.js";
import { CAMERA_MOVE_S, type CameraBoxResolver } from "./diagram-map.js";
import { DEFAULT_DOCTRINE_DIR } from "./doctrine-load.js";
import type { L0Check, L0Result } from "./eval-l0.js";
import type { MapEvent, MapSegment, MapTimeline } from "./map-timeline.js";

const Severity = z.enum(["error", "warning"]);
const LimitRowSchema = z.strictObject({ severity: Severity, max: z.number().positive() });
const FramingRowSchema = z.strictObject({ severity: Severity });

const CameraPathDoctrineSchema = z.strictObject({
  schema: z.literal("explainer.camera-path/v1"),
  sampleRateMultiple: z.number().int().positive(),
  easing: z.strictObject({ model: z.literal("smootherstep"), assumed: z.boolean() }),
  captionTop: z.number().gt(0).max(1),
  rows: z.strictObject({
    "camera:velocity": LimitRowSchema,
    "camera:jerk": LimitRowSchema,
    "camera:key-in-frame": FramingRowSchema,
    "camera:seen-before-reveal": FramingRowSchema,
  }),
});
export type CameraPathDoctrine = z.infer<typeof CameraPathDoctrineSchema>;

/** Reads `qa/camera-path.yaml` under `dir`: the camera-path rows' severities, limits, easing model and sample rate. */
export function loadCameraPathDoctrine(dir: string = DEFAULT_DOCTRINE_DIR): CameraPathDoctrine {
  return CameraPathDoctrineSchema.parse(parse(readFileSync(join(dir, "qa", "camera-path.yaml"), "utf8")));
}

/** A focused box that must stay in frame and above the captions from `fromS` to `toS`, inclusive. */
export interface CameraKeyBox {
  id: string;
  beatId: string;
  box: Box;
  fromS: number;
  toS: number;
}

/** A revealed object the camera must not hold whole in frame from `fromS` until its cue at `atS`. */
export interface CameraReveal {
  id: string;
  beatId: string;
  box: Box;
  fromS: number;
  atS: number;
}

/** A sampled camera track, the beats it spans, and the layout boxes its framing rows test. */
export interface CameraPathInput {
  track: CameraSample[];
  beats: { beatId: string; startS: number }[];
  keyBoxes: CameraKeyBox[];
  reveals: CameraReveal[];
}

type RowId = keyof CameraPathDoctrine["rows"];

function row(checkId: RowId, flaggedBeats: readonly string[], severity: L0Result["severity"]): L0Result {
  const beats = [...new Set(flaggedBeats)];
  return { check_id: checkId, mode: "heuristic", severity, value: beats.length, threshold: 0, pass: beats.length === 0, detail_beats: beats };
}

function beatAt(beats: CameraPathInput["beats"], t: number): string {
  return beats.reduce((found, beat) => (beat.startS <= t ? beat.beatId : found), beats[0]?.beatId ?? "");
}

/** The four camera-path rows over one sampled track, each naming the beats it flags. */
export function cameraPathRows(input: CameraPathInput, doctrine: CameraPathDoctrine): L0Result[] {
  const { rows } = doctrine;
  const limits = { velocity: rows["camera:velocity"].max, jerk: rows["camera:jerk"].max };
  const [velocity, jerk] = cameraMotionRows(input.track, limits);
  const spikeBeats = (times: readonly number[]) => times.map((t) => beatAt(input.beats, t));
  const strayKeys = input.keyBoxes.filter((key) => keyBoxRows(input.track, [key]).length > 0);
  const earlyReveals = input.reveals.filter((reveal) => revealRows(input.track.filter((s) => s.t >= reveal.fromS), [reveal]).length > 0);
  return [
    row("camera:velocity", spikeBeats(velocity!.times), rows["camera:velocity"].severity),
    row("camera:jerk", spikeBeats(jerk!.times), rows["camera:jerk"].severity),
    row("camera:key-in-frame", strayKeys.map((k) => k.beatId), rows["camera:key-in-frame"].severity),
    row("camera:seen-before-reveal", earlyReveals.map((r) => r.beatId), rows["camera:seen-before-reveal"].severity),
  ];
}

/** The camera-path rows; dormant until a caller passes a camera track, as the map lints skip a run with no layout. */
export const cameraPathCheck: L0Check = ({ camera }) =>
  camera && camera.track.length > 0 ? cameraPathRows(camera, loadCameraPathDoctrine()) : [];

/** Resolves a beat's camera target and a map id to layout boxes, and names the render's frame rate. */
export interface CameraPathFromMapOptions {
  cameraBox: CameraBoxResolver;
  layoutBox: (id: string) => Box;
  fps: number;
}

interface Move {
  atS: number;
  from: Box;
  to: Box;
}

const smootherstep = (u: number): number => u * u * u * (u * (6 * u - 15) + 10);
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
const lerpBox = (a: Box, b: Box, k: number): Box => ({
  x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), width: lerp(a.width, b.width, k), height: lerp(a.height, b.height, k),
});

function poseAt(moves: readonly Move[], t: number): Box {
  const move = moves.findLast((m) => m.atS <= t) ?? moves[0]!;
  const progress = Math.min(1, Math.max(0, (t - move.atS) / CAMERA_MOVE_S));
  return lerpBox(move.from, move.to, smootherstep(progress));
}

// The first station is the opening frame; each later one starts from the pose at its cue, so an interrupt eases from mid-move.
function stationMoves(stations: readonly { atS: number; box: Box }[]): Move[] {
  const moves: Move[] = [];
  for (const { atS, box } of stations) moves.push({ atS, from: moves.length === 0 ? box : poseAt(moves, atS), to: box });
  return moves;
}

const ofKind = (segment: MapSegment, kind: MapEvent["kind"]): MapEvent[] => segment.events.filter((event) => event.kind === kind);

function sampledTrack(timeline: MapTimeline, cameraBox: CameraBoxResolver, rate: number): CameraSample[] {
  const { segments } = timeline;
  const stations = segments.flatMap((s) => ofKind(s, "camera").map((e) => ({ atS: e.atS, box: cameraBox(s.beatId, e.id) })));
  if (stations.length === 0) return [];
  const moves = stationMoves(stations.sort((a, b) => a.atS - b.atS));
  const startS = segments[0]!.startS;
  const count = Math.floor((segments.at(-1)!.endS - startS) * rate) + 1;
  return Array.from({ length: count }, (_, i) => {
    const t = startS + i / rate;
    return { t, box: poseAt(moves, t) };
  });
}

function segmentKeyBoxes(segment: MapSegment, layoutBox: CameraPathFromMapOptions["layoutBox"]): CameraKeyBox[] {
  const focus = ofKind(segment, "focus");
  return focus.flatMap((event) => {
    const toS = focus.find((next) => next.atS > event.atS)?.atS ?? segment.endS;
    return (event.ids ?? []).map((id) => ({ id, beatId: segment.beatId, box: layoutBox(id), fromS: event.atS, toS }));
  });
}

/**
 * A compiled map track as camera-path input: the camera eased between stations at `fps` times the doctrine's sample
 * multiple, each focus id a key box until the beat's next focus or its end, and each reveal checked from its beat's start.
 */
export function cameraPathFromMap(timeline: MapTimeline, options: CameraPathFromMapOptions, doctrine = loadCameraPathDoctrine()): CameraPathInput {
  const { segments } = timeline;
  const { cameraBox, layoutBox, fps } = options;
  return {
    track: sampledTrack(timeline, cameraBox, fps * doctrine.sampleRateMultiple),
    beats: segments.map((s) => ({ beatId: s.beatId, startS: s.startS })),
    keyBoxes: segments.flatMap((s) => segmentKeyBoxes(s, layoutBox)),
    reveals: segments.flatMap((s) => ofKind(s, "reveal").map((e) => ({ id: e.id, beatId: s.beatId, box: layoutBox(e.id), fromS: s.startS, atS: e.atS }))),
  };
}
