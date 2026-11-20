import { type Box, type CameraSample, CAPTION_KEEP_OUT, projectBox } from "./camera.js";

/** A box that must stay above the caption band for the seconds `fromS`..`toS`, inclusive. */
interface KeyBox {
  id: string;
  box: Box;
  fromS: number;
  toS: number;
}

/** An object the narration reveals at `atS`; the camera must not frame it wholly before then. */
interface RevealObject {
  id: string;
  box: Box;
  atS: number;
}

interface FramingRow {
  rule: "camera:key-in-frame" | "camera:seen-before-reveal";
  t: number;
  id: string;
}

function within(box: Box, bottom: number): boolean {
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= 1 && box.y + box.height <= bottom;
}

export function keyBoxRows(track: readonly CameraSample[], keys: readonly KeyBox[]): FramingRow[] {
  return keys.flatMap((key) =>
    track
      .filter((s) => s.t >= key.fromS && s.t <= key.toS && !within(projectBox(key.box, s.box), CAPTION_KEEP_OUT))
      .map((s): FramingRow => ({ rule: "camera:key-in-frame", t: s.t, id: key.id })),
  );
}

export function revealRows(track: readonly CameraSample[], reveals: readonly RevealObject[]): FramingRow[] {
  return reveals.flatMap((reveal) =>
    track
      .filter((s) => s.t < reveal.atS && within(projectBox(reveal.box, s.box), 1))
      .map((s): FramingRow => ({ rule: "camera:seen-before-reveal", t: s.t, id: reveal.id })),
  );
}
