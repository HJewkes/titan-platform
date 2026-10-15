import {
  labelBoxSizing,
  placePills,
  type DroppedPill,
  type LabelMetrics,
  type PillScene,
  type PinSpec,
  type Rect,
} from "@titan-design/graph-layout";
import { CAPTION_KEEP_OUT } from "./camera.js";
import type { CueResolver } from "./cues.js";
import type { MapBeat } from "./map-state.js";
import type { MapSegment, MapTimeline } from "./map-timeline.js";

/** Why a pin has no box: graph-layout's drop reason, or `no-scene` for a beat with no scene to place in. */
export type UnplacedReason = DroppedPill["reason"] | "no-scene";

/**
 * A pin as the painter draws it. A null `box` carries its `reason`, and the painter falls back to
 * an anchor offset.
 */
export type PlacedPin = { atS: number; anchor: string; text: string } & (
  | { box: Rect }
  | { box: null; reason: UnplacedReason }
);

export interface PinLayout {
  /** The scene a beat's pins are placed in: anchor boxes, labels to avoid and the camera frame, in layout units. */
  sceneFor: (beatId: string) => PillScene | undefined;
  /** How a pill's text is drawn; a pill is sized as a label box with this padding and body. */
  metrics: LabelMetrics;
  gap: number;
}

export type PinnedSegment = MapSegment & { pins: PlacedPin[] };

export interface PinnedMapTimeline {
  segments: PinnedSegment[];
}

type TimedPin = PinSpec & { atS: number; text: string };

function timedPins(beat: MapBeat, startS: number, resolveCue: CueResolver, metrics: LabelMetrics): TimedPin[] {
  const pins = (beat.visual?.map_state?.pins ?? [])
    .map((p) => ({ anchor: p.anchor, text: p.text, atS: startS + resolveCue(beat.id, p.atCue) }))
    .sort((a, b) => a.atS - b.atS || a.anchor.localeCompare(b.anchor) || a.text.localeCompare(b.text));
  const sizes = labelBoxSizing(new Map(pins.map((p, i) => [String(i), p.text])), metrics);
  return pins.map((p, i) => ({ ...p, id: `${p.anchor}#${i}`, rank: p.atS, ...sizes.get(String(i))! }));
}

/**
 * Places every map beat's pins at build time and writes each pin's box into its segment, so the
 * painter takes positions as props. Pills stay above the caption keep-out; earlier-cued pins win
 * the spots nearest their boxes.
 */
export function placeTimelinePins(timeline: MapTimeline, beats: readonly MapBeat[], resolveCue: CueResolver, layout: PinLayout): PinnedMapTimeline {
  const beatsById = new Map(beats.map((b) => [b.id, b]));
  const segments = timeline.segments.map((segment): PinnedSegment => {
    const beat = beatsById.get(segment.beatId);
    const pins = beat ? timedPins(beat, segment.startS, resolveCue, layout.metrics) : [];
    return { ...segment, pins: placeSegmentPins(pins, layout.sceneFor(segment.beatId), layout.gap) };
  });
  return { segments };
}

function placeSegmentPins(pins: readonly TimedPin[], scene: PillScene | undefined, gap: number): PlacedPin[] {
  const result = scene ? placePills(scene, pins, { gap, keepOut: CAPTION_KEEP_OUT }) : { placed: [], dropped: [] };
  const boxes = new Map(result.placed.map((p) => [p.id, p.rect]));
  const reasons = new Map(result.dropped.map((d) => [d.id, d.reason]));
  return pins.map(({ atS, anchor, text, id }): PlacedPin => {
    const box = boxes.get(id);
    return box ? { atS, anchor, text, box } : { atS, anchor, text, box: null, reason: reasons.get(id) ?? "no-scene" };
  });
}
