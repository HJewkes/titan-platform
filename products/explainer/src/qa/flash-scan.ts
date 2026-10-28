import { spawnFfmpeg, type FfmpegExec } from "@titan-design/render-qa";
import { z } from "zod";

/**
 * WCAG 2.3.1 three-flash rule over the MP4's safe area (content standards CH-28), as a sampled-frame approximation.
 * Every decoded frame is area-scaled to 160x90 and each pixel's sRGB linearised. A pixel changes state on a swing of
 * at least 0.10 relative luminance whose darker end is below 0.80 (general), or of more than 20 in (R-G-B)x320 to or
 * from a saturated red, R/(R+G+B) >= 0.8 (red, the numeric red-flash note of WCAG 2.0). Two opposing changes make one
 * flash. A second holds N flashes when the pixels with N or more in it cover the small-area threshold: 25 % of a
 * 341x256 field at 1024x768, as a share of the frame. That share is counted over the whole safe area, not within one
 * 10-degree field, so spread flashes over-report; the scaling blurs patterns finer than about 12 px at 1920 wide.
 */
const FLASH_METHOD = "every frame at 160x90, title-safe 90 %, small area 2.78 % of frame, trailing 1 s";

const FLASH_WIDTH = 160;
const FLASH_HEIGHT = 90;
/** Title-safe: the middle 90 % of each side. */
const SAFE_INSET = 0.05;
const SMALL_AREA_SHARE = (0.25 * 341 * 256) / (1024 * 768);
const GENERAL_SWING = 0.1;
const DARK_MAX = 0.8;
const RED_SWING = 20;
const RED_SATURATION = 0.8;
/** WCAG 2.3.1 allows three flashes in any one second; a fourth fails. */
export const MAX_FLASHES_PER_S = 3;

const WindowSchema = z.object({ startS: z.number(), endS: z.number() });
const FlashKindSchema = z.object({ maxPerS: z.number().int().nonnegative(), windows: z.array(WindowSchema) });

/** The scan as qa.json records it: per kind, the most flashes in any second and the seconds above three. */
export const FlashReportSchema = z.object({ method: z.string(), general: FlashKindSchema, red: FlashKindSchema });
export type FlashReport = z.infer<typeof FlashReportSchema>;
type FlashKind = z.infer<typeof FlashKindSchema>;

const LINEAR = Float32Array.from({ length: 256 }, (_, c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4));

/** One frame's safe-area pixels: relative luminance, the red measure (R-G-B)x320, and whether each is a saturated red. */
interface Sample {
  lum: Float32Array;
  red: Float32Array;
  saturated: Uint8Array;
}

function safeArea(): Uint32Array {
  const [x0, x1] = [Math.round(FLASH_WIDTH * SAFE_INSET), Math.round(FLASH_WIDTH * (1 - SAFE_INSET))];
  const [y0, y1] = [Math.round(FLASH_HEIGHT * SAFE_INSET), Math.round(FLASH_HEIGHT * (1 - SAFE_INSET))];
  const cells: number[] = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cells.push(y * FLASH_WIDTH + x);
  return Uint32Array.from(cells);
}

function sample(rgb: Uint8Array, cells: Uint32Array): Sample {
  const out = { lum: new Float32Array(cells.length), red: new Float32Array(cells.length), saturated: new Uint8Array(cells.length) };
  for (const [j, cell] of cells.entries()) {
    const [r, g, b] = [LINEAR[rgb[cell * 3]!]!, LINEAR[rgb[cell * 3 + 1]!]!, LINEAR[rgb[cell * 3 + 2]!]!];
    out.lum[j] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    out.red[j] = Math.max(0, r - g - b) * 320;
    out.saturated[j] = r + g + b > 0 && r / (r + g + b) >= RED_SATURATION ? 1 : 0;
  }
  return out;
}

/** Whether a swing from `ref` to `value` counts: its size, and the kind's own condition on the two states. */
interface Rule {
  swing: number;
  counts(value: number, ref: number, flag: number, refFlag: number): boolean;
}

const GENERAL: Rule = { swing: GENERAL_SWING, counts: (value, ref) => Math.min(value, ref) < DARK_MAX };
const RED: Rule = { swing: RED_SWING, counts: (_value, _ref, flag, refFlag) => flag === 1 || refFlag === 1 };

/**
 * One kind's per-pixel state: the last extreme, the direction that reached it, and the state changes in the trailing
 * second, with a histogram of pixels by flashes held so each frame's count reads without a pass over every pixel.
 */
interface Tracker {
  rule: Rule;
  ref: Float32Array;
  refFlag: Uint8Array;
  dir: Int8Array;
  changes: Uint16Array;
  window: Uint32Array[];
  byFlashes: number[];
}

function tracker(rule: Rule, first: Float32Array, flags: Uint8Array): Tracker {
  return { rule, ref: Float32Array.from(first), refFlag: Uint8Array.from(flags), dir: new Int8Array(first.length), changes: new Uint16Array(first.length), window: [], byFlashes: [first.length] };
}

function bump(t: Tracker, j: number, by: 1 | -1): void {
  const before = t.changes[j]! >> 1;
  t.changes[j]! += by;
  const after = t.changes[j]! >> 1;
  if (before === after) return;
  t.byFlashes[before]! -= 1;
  t.byFlashes[after] = (t.byFlashes[after] ?? 0) + 1;
}

/** Moves each pixel's extreme along a swing that continues it, and records a swing back that counts as a change. */
function changesIn(t: Tracker, values: Float32Array, flags: Uint8Array): Uint32Array {
  const changed: number[] = [];
  for (let j = 0; j < values.length; j++) {
    const delta = values[j]! - t.ref[j]!;
    const dir = Math.sign(delta);
    const extends_ = dir !== 0 && dir === t.dir[j];
    if (!extends_ && (Math.abs(delta) < t.rule.swing || !t.rule.counts(values[j]!, t.ref[j]!, flags[j]!, t.refFlag[j]!))) continue;
    t.ref[j] = values[j]!;
    t.refFlag[j] = flags[j]!;
    if (extends_) continue;
    t.dir[j] = dir;
    changed.push(j);
  }
  return Uint32Array.from(changed);
}

/** Steps a tracker one frame and returns the flashes in the second ending there that cover the small area. */
function step(t: Tracker, values: Float32Array, flags: Uint8Array, windowFrames: number, area: number): number {
  const changed = changesIn(t, values, flags);
  for (const j of changed) bump(t, j, 1);
  t.window.push(changed);
  if (t.window.length > windowFrames) for (const j of t.window.shift()!) bump(t, j, -1);
  let covered = 0;
  for (let n = t.byFlashes.length - 1; n > 0; n--) {
    covered += t.byFlashes[n] ?? 0;
    if (covered >= area) return n;
  }
  return 0;
}

const round2 = (s: number): number => Math.round(s * 100) / 100;

/** The second ending at each frame above the limit, overlapping seconds merged. */
function summarise(perFrame: readonly number[], fps: number): FlashKind {
  const windows: FlashKind["windows"] = [];
  for (const [f, n] of perFrame.entries()) {
    if (n <= MAX_FLASHES_PER_S) continue;
    const [startS, endS] = [round2(Math.max(0, (f + 1) / fps - 1)), round2((f + 1) / fps)];
    const last = windows.at(-1);
    if (last !== undefined && startS <= last.endS) last.endS = endS;
    else windows.push({ startS, endS });
  }
  return { maxPerS: Math.max(0, ...perFrame), windows };
}

/** Decode arguments: every frame of `video`, area-scaled to the scan size, as raw 8-bit RGB on stdout. */
function flashScanArgs(video: string): string[] {
  return ["-v", "error", "-i", video, "-vf", `scale=${FLASH_WIDTH}:${FLASH_HEIGHT}:flags=area,format=rgb24`, "-f", "rawvideo", "-"];
}

async function* frames(video: string, exec: FfmpegExec): AsyncIterable<Uint8Array> {
  const bytes = FLASH_WIDTH * FLASH_HEIGHT * 3;
  let pending = Buffer.alloc(0);
  for await (const chunk of exec(flashScanArgs(video))) {
    pending = Buffer.concat([pending, chunk]);
    for (; pending.length >= bytes; pending = pending.subarray(bytes)) yield new Uint8Array(pending.subarray(0, bytes));
  }
}

/** General and red flashes per second of `video`, played at `fps`; ffmpeg failing rejects. */
export async function flashScan(video: string, fps: number, exec: FfmpegExec = spawnFfmpeg): Promise<FlashReport> {
  const cells = safeArea();
  const area = Math.ceil(SMALL_AREA_SHARE * FLASH_WIDTH * FLASH_HEIGHT);
  const windowFrames = Math.round(fps);
  let trackers: { general: Tracker; red: Tracker } | undefined;
  const perFrame = { general: [] as number[], red: [] as number[] };
  for await (const rgb of frames(video, exec)) {
    const s = sample(rgb, cells);
    trackers ??= { general: tracker(GENERAL, s.lum, s.saturated), red: tracker(RED, s.red, s.saturated) };
    perFrame.general.push(step(trackers.general, s.lum, s.saturated, windowFrames, area));
    perFrame.red.push(step(trackers.red, s.red, s.saturated, windowFrames, area));
  }
  return { method: FLASH_METHOD, general: summarise(perFrame.general, fps), red: summarise(perFrame.red, fps) };
}
