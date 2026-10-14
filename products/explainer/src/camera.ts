import { z } from "zod";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FRAME_ASPECT = 16 / 9;
// Captions own the frame below this line, so a focused box must project above it.
export const CAPTION_KEEP_OUT = 0.83;
export const DEFAULT_PADDING = 24;

/** `camera/<beat>.json`: the layout-space box the camera frames for one beat. */
export const CameraStationSchema = z.object({
  beatId: z.string().min(1),
  focus: z.array(z.string().min(1)).min(1),
  box: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }),
});

export type CameraStation = z.infer<typeof CameraStationSchema>;

export interface LayoutBox extends Box {
  id: string;
}

function union(boxes: readonly Box[]): Box {
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The 16:9 camera box around `content`, sized so the content fits inside the frame's top
 * `CAPTION_KEEP_OUT` band, centred horizontally and within that band.
 */
export function fitBox(content: Box, padding = DEFAULT_PADDING): Box {
  const padded = { x: content.x - padding, y: content.y - padding, width: content.width + 2 * padding, height: content.height + 2 * padding };
  const height = Math.max(padded.height / CAPTION_KEEP_OUT, padded.width / FRAME_ASPECT);
  const width = height * FRAME_ASPECT;
  const bandSlack = height * CAPTION_KEEP_OUT - padded.height;
  return {
    x: padded.x + padded.width / 2 - width / 2,
    y: padded.y - bandSlack / 2,
    width,
    height,
  };
}

/** Where a layout box lands in the frame, as 0..1 fractions of the frame's width and height. */
export function projectBox(box: Box, camera: Box): Box {
  return {
    x: (box.x - camera.x) / camera.width,
    y: (box.y - camera.y) / camera.height,
    width: box.width / camera.width,
    height: box.height / camera.height,
  };
}

/** The camera station for a beat that focuses `focusIds`. An id missing from the layout throws. */
export function cameraStation(beatId: string, layout: readonly LayoutBox[], focusIds: readonly string[], padding?: number): CameraStation {
  const byId = new Map(layout.map((box) => [box.id, box]));
  const focus = [...new Set(focusIds)].sort();
  if (focus.length === 0) throw new Error(`${beatId} has no focus ids to frame`);
  const boxes = focus.map((id) => {
    const box = byId.get(id);
    if (!box) throw new Error(`focus id ${id} in ${beatId} is not in the layout`);
    return box;
  });
  return { beatId, focus, box: fitBox(union(boxes), padding) };
}

/** The path and contents of a station's file, relative to the video's build directory. */
export function cameraStationFile(station: CameraStation): { path: string; json: string } {
  return { path: `camera/${station.beatId}.json`, json: `${JSON.stringify(station, null, 2)}\n` };
}
