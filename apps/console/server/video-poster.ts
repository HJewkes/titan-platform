import path from "node:path";

const POSTER_TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
/** A contact sheet is a grid of frames for review, not a cover; the client shows its no-source state instead. */
const CONTACT_SHEET = /contact|sheet/i;

/** File names beside the video to try, in precedence order: the sidecar's `poster`, then `-poster.jpg`, then `-poster.png`. */
export function posterNames(videoName: string, sidecarPoster: string | undefined): string[] {
  const stem = path.parse(videoName).name;
  const names = [...(sidecarPoster === undefined ? [] : [sidecarPoster]), `${stem}-poster.jpg`, `${stem}-poster.png`];
  return names.filter((name) => !CONTACT_SHEET.test(name));
}

export function posterContentType(file: string): string {
  return POSTER_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}
