import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { projectBox, type Box } from "./camera.js";
import { cameraMotion, cameraTrack, EASING_NAMES, type CameraKey, type MotionSample } from "./camera-motion.js";
import { CAMERA_MOVE_S, type CameraBoxResolver } from "./diagram-map.js";
import { DEFAULT_DOCTRINE_DIR } from "./doctrine-load.js";
import type { L0Check, L0Result } from "./eval-l0.js";
import type { MapEvent, MapSegment, MapTimeline } from "./map-timeline.js";

const Severity = z.enum(["error", "warning"]);
const LimitRowSchema = z.strictObject({ severity: Severity, max: z.number().positive() });
const CountRowSchema = z.strictObject({ severity: Severity });

const CameraPathDoctrineSchema = z.strictObject({
  schema: z.literal("explainer.camera-path/v1"),
  sampleHz: z.number().positive(),
  easing: z.enum(EASING_NAMES),
  captionTop: z.number().gt(0).max(1),
  rows: z.strictObject({ velocity: LimitRowSchema, jerk: LimitRowSchema, "key-in-frame": CountRowSchema, "reveal-early": CountRowSchema }),
});
export type CameraPathDoctrine = z.infer<typeof CameraPathDoctrineSchema>;

/** Reads `qa/camera-path.yaml` under `dir`: the camera-path rows' severities, limits, easing model and sample rate. */
export function loadCameraPathDoctrine(dir: string = DEFAULT_DOCTRINE_DIR): CameraPathDoctrine {
  return CameraPathDoctrineSchema.parse(parse(readFileSync(join(dir, "qa", "camera-path.yaml"), "utf8")));
}

/** A box the beat is about: it must stay in frame and above the caption strip from `startS` until `endS`. */
export interface KeyWindow {
  id: string;
  beatId: string;
  startS: number;
  endS: number;
  box: Box;
}

/** An object revealed on a cue: the camera must not hold it whole in frame from `fromS` until `atS`. */
export interface RevealCue {
  id: string;
  beatId: string;
  fromS: number;
  atS: number;
  box: Box;
}

/** A resolved camera track and the layout boxes its rows test, all in layout units and video seconds. */
export interface CameraPathInput {
  keys: CameraKey[];
  keyBoxes: KeyWindow[];
  reveals: RevealCue[];
}

// Absorbs float error, so a box fitted exactly to the frame's edge stays inside it.
const EPS = 1e-9;

const within = (p: Box, bottom: number): boolean => p.x >= -EPS && p.y >= -EPS && p.x + p.width <= 1 + EPS && p.y + p.height <= bottom + EPS;

/** Sample times from `fromS` up to, not including, `toS`. */
const windowTimes = (fromS: number, toS: number, hz: number): number[] =>
  Array.from({ length: Math.max(0, Math.ceil((toS - fromS) * hz)) }, (_, i) => fromS + i / hz);

const unique = (ids: readonly string[]): string[] => [...new Set(ids)];
const round2 = (n: number): number => Math.round(n * 100) / 100;

function peakRow(rule: "velocity" | "jerk", samples: readonly MotionSample[], { severity, max }: CameraPathDoctrine["rows"]["velocity"]): L0Result {
  const peak = samples.reduce((top, sample) => Math.max(top, sample.value), 0);
  // Written as "not at most", so a NaN sample from a degenerate box fails instead of slipping past the limit.
  const over = samples.filter((sample) => !(sample.value <= max));
  return { check_id: `camera:${rule}`, mode: "heuristic", severity, value: round2(peak), threshold: max, pass: over.length === 0, detail_beats: unique(over.map((s) => s.beatId)) };
}

function countRow(rule: "key-in-frame" | "reveal-early", failed: readonly { beatId: string }[], { severity }: CameraPathDoctrine["rows"]["key-in-frame"]): L0Result {
  return { check_id: `camera:${rule}`, mode: "heuristic", severity, value: failed.length, threshold: 0, pass: failed.length === 0, detail_beats: unique(failed.map((f) => f.beatId)) };
}

/**
 * The camera-path rows over one resolved track: peak speed and jerk against their limits, key boxes that leave the
 * frame or dip into the captions during their window, and reveal objects held whole in frame before their cue.
 */
export function cameraPathRows(input: CameraPathInput, doctrine: CameraPathDoctrine): L0Result[] {
  const { sampleHz: hz, easing, captionTop, rows } = doctrine;
  const { speed, jerk } = cameraMotion(input.keys, easing, hz);
  const { boxAt } = cameraTrack(input.keys, easing);
  const seen = (box: Box, bottom: number) => (t: number): boolean => within(projectBox(box, boxAt(t)), bottom);
  const strayKeys = input.keyBoxes.filter((key) => !windowTimes(key.startS, key.endS, hz).every(seen(key.box, captionTop)));
  const earlyReveals = input.reveals.filter((reveal) => windowTimes(reveal.fromS, reveal.atS, hz).some(seen(reveal.box, 1)));
  return [
    peakRow("velocity", speed, rows.velocity),
    peakRow("jerk", jerk, rows.jerk),
    countRow("key-in-frame", strayKeys, rows["key-in-frame"]),
    countRow("reveal-early", earlyReveals, rows["reveal-early"]),
  ];
}

/** The camera-path rows; a run with no resolved camera track skips them, as the map lints skip a run with no layout. */
export const cameraPathCheck: L0Check = ({ camera }) => (camera && camera.keys.length > 0 ? cameraPathRows(camera, loadCameraPathDoctrine()) : []);

/** Resolves a camera target to its layout box, and a map id to its layout box. */
export interface CameraPathResolvers {
  cameraBox: CameraBoxResolver;
  layoutBox: (id: string) => Box;
}

const ofKind = (segment: MapSegment, kind: MapEvent["kind"]): MapEvent[] => segment.events.filter((event) => event.kind === kind);

function segmentKeyBoxes(segment: MapSegment, layoutBox: CameraPathResolvers["layoutBox"]): KeyWindow[] {
  const focus = ofKind(segment, "focus");
  return focus.flatMap((event) => {
    const endS = focus.find((next) => next.atS > event.atS)?.atS ?? segment.endS;
    return (event.ids ?? []).map((id) => ({ id, beatId: segment.beatId, startS: event.atS, endS, box: layoutBox(id) }));
  });
}

/**
 * A compiled map track as camera-path input: each camera event a key that moves over CAMERA_MOVE_S, each focus id a key
 * box until the beat's next focus or its end, and each reveal checked from the beat's start to its cue.
 */
export function cameraPathFromMap(timeline: MapTimeline, { cameraBox, layoutBox }: CameraPathResolvers): CameraPathInput {
  const { segments } = timeline;
  return {
    keys: segments.flatMap((s) => ofKind(s, "camera").map((e) => ({ beatId: s.beatId, atS: e.atS, durS: CAMERA_MOVE_S, box: cameraBox(s.beatId, e.id) }))),
    keyBoxes: segments.flatMap((s) => segmentKeyBoxes(s, layoutBox)),
    reveals: segments.flatMap((s) => ofKind(s, "reveal").map((e) => ({ id: e.id, beatId: s.beatId, fromS: s.startS, atS: e.atS, box: layoutBox(e.id) }))),
  };
}
