import { z } from "zod";
import type { Box } from "./camera.js";
import { MAP_LEVELS } from "./map-state.js";
import type { MapEvent, MapSegment, MapTimeline } from "./map-timeline.js";

// A TP-side mirror of titan-design's MapTimeline contract (network-graph/map/types.ts). It is strict, so a
// renamed or added field in the copied fixture fails diagram-map.test.ts instead of drifting silently.
const BoxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).strict();
const Ids = z.array(z.string().min(1));
const MarkSchema = z.enum(["circle", "box", "underline", "arrow", "marker"]);
const timed = <T extends z.ZodRawShape>(shape: T) => z.object({ atS: z.number().nonnegative(), durS: z.number().nonnegative(), ...shape }).strict();

export const DiagramMapKeyframeSchema = z.discriminatedUnion("op", [
  timed({ op: z.enum(["reveal", "edge", "focus", "lit", "card-in", "card-out"]), ids: Ids }),
  timed({ op: z.literal("level"), level: z.number().int().nonnegative() }),
  timed({ op: z.literal("minimap"), on: z.boolean() }),
  timed({ op: z.literal("camera"), box: BoxSchema }),
  timed({
    op: z.literal("flow"),
    flowId: z.string().min(1),
    fromHop: z.number().int().nonnegative(),
    toHop: z.number().int().nonnegative(),
    speed: z.union([z.literal(1), z.literal(3)]).optional(),
    // Not in titan-design's contract yet: its flow layer reads them once it adds untilCue and hopCues.
    hopAtS: z.array(z.number()).optional(),
    untilAtS: z.number().optional(),
  }),
  timed({ op: z.literal("annotate"), anchor: z.string().min(1), mark: MarkSchema }),
  timed({ op: z.literal("pin"), anchor: z.string().min(1), text: z.string() }),
]);

export const DiagramMapTimelineSchema = z
  .object({
    layoutSha: z.string().min(1),
    spans: z.array(z.object({ startS: z.number(), endS: z.number() }).strict()).optional(),
    keyframes: z.array(DiagramMapKeyframeSchema),
  })
  .strict();

export type DiagramMapBox = z.infer<typeof BoxSchema>;
export type DiagramMapKeyframe = z.infer<typeof DiagramMapKeyframeSchema>;
export type DiagramMapTimeline = z.infer<typeof DiagramMapTimelineSchema>;

/** The layout-space box the camera frames for a beat's camera target (a station id, or fit ids joined by commas). */
export type CameraBoxResolver = (beatId: string, target: string) => Box;

export interface DiagramMapOptions {
  layoutSha: string;
  cameraBox?: CameraBoxResolver;
}

// Durations follow titan-design's fixture; camera, annotate and pin are TP's picks until
// titan-design's camera and flow layers set them.
// A flow's 0 leaves its timing to the flow layer, which knows each hop's route length.
const DUR_S: Record<DiagramMapKeyframe["op"], number> = {
  level: 0,
  minimap: 0.25,
  reveal: 0.4,
  edge: 0.6,
  focus: 0.4,
  lit: 0.4,
  "card-in": 0.25,
  "card-out": 0.25,
  camera: 1,
  annotate: 0.4,
  pin: 0.25,
  flow: 0,
};

type Op = DiagramMapKeyframe extends infer K ? (K extends DiagramMapKeyframe ? Omit<K, "atS" | "durS"> : never) : never;

const keyframe = (atS: number, op: Op): DiagramMapKeyframe => ({ atS, durS: DUR_S[op.op], ...op });

function cameraOp(event: MapEvent, beatId: string, cameraBox: CameraBoxResolver | undefined): Op {
  if (!cameraBox) throw new Error(`${beatId} moves the camera, but no cameraBox resolver was given`);
  const { x, y, width, height } = cameraBox(beatId, event.id);
  return { op: "camera", box: { x, y, w: width, h: height } };
}

function eventOp(event: MapEvent, beatId: string, cameraBox: CameraBoxResolver | undefined): Op {
  switch (event.kind) {
    case "camera":
      return cameraOp(event, beatId, cameraBox);
    case "focus":
      return { op: "focus", ids: event.ids ?? [] };
    case "flow":
      if (!event.walk) throw new Error(`${beatId}: flow event ${event.id} has no walk`);
      return { op: "flow", ...event.walk };
    case "annotation": {
      const [mark, ...anchor] = event.id.split(":");
      return { op: "annotate", anchor: anchor.join(":"), mark: MarkSchema.parse(mark) };
    }
    case "pin":
      return { op: "pin", anchor: event.id, text: event.text ?? "" };
    default:
      return { op: event.kind, ids: [event.id] };
  }
}

interface Carried {
  level: number | null;
  minimap: boolean;
}

function segmentKeyframes(segment: MapSegment, carried: Carried, cameraBox: CameraBoxResolver | undefined): DiagramMapKeyframe[] {
  const level = MAP_LEVELS.indexOf(segment.end.level);
  const frames = [
    ...(level !== carried.level ? [keyframe(segment.startS, { op: "level", level })] : []),
    ...(segment.minimap !== carried.minimap ? [keyframe(segment.startS, { op: "minimap", on: segment.minimap })] : []),
    ...segment.events.map((event) => keyframe(event.atS, eventOp(event, segment.beatId, cameraBox))),
  ];
  carried.level = level;
  carried.minimap = segment.minimap;
  return frames;
}

// After time and op, the keyframe's own JSON breaks ties; every op is built with a fixed field order.
const byTimeOpIds = (a: DiagramMapKeyframe, b: DiagramMapKeyframe): number =>
  a.atS - b.atS || a.op.localeCompare(b.op) || JSON.stringify(a).localeCompare(JSON.stringify(b));

function spansOf(segments: readonly MapSegment[]): { startS: number; endS: number }[] {
  const spans: { startS: number; endS: number }[] = [];
  for (const { startS, endS } of segments) {
    const last = spans.at(-1);
    if (last && last.endS === startS) last.endS = endS;
    else spans.push({ startS, endS });
  }
  return spans;
}

/**
 * Converts a compiled map track into titan-design's MapTimeline: the layout's sha, the spans the map is
 * on screen, and keyframes sorted by time, op and ids so equal storyboards emit byte-equal timelines.
 */
export function toDiagramMapTimeline(timeline: MapTimeline, { layoutSha, cameraBox }: DiagramMapOptions): DiagramMapTimeline {
  const carried: Carried = { level: null, minimap: false };
  const keyframes = timeline.segments.flatMap((segment) => segmentKeyframes(segment, carried, cameraBox)).sort(byTimeOpIds);
  return { layoutSha, spans: spansOf(timeline.segments), keyframes };
}
