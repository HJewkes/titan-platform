import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface ImageAttachment {
  path: string;
  mediaType: "image/png" | "image/jpeg";
  data: Buffer;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

/** Reads every image up front so a bad path fails the run before anything spawns. The bytes decide the type, not the extension. */
export function readImageAttachments(paths: readonly string[]): { images: ImageAttachment[] } | { reason: string } {
  const images: ImageAttachment[] = [];
  for (const path of paths) {
    const image = readImage(path);
    if (typeof image === "string") return { reason: image };
    images.push(image);
  }
  return { images };
}

function readImage(path: string): ImageAttachment | string {
  if (!isAbsolute(path)) return `image path must be absolute: ${path}`;
  let data: Buffer;
  try {
    data = readFileSync(path);
  } catch (error) {
    return `cannot read image ${path}: ${error instanceof Error ? error.message : String(error)}`;
  }
  const mediaType = sniffMediaType(data);
  return mediaType ? { path, mediaType, data } : `image ${path} is not a PNG or JPEG file`;
}

function sniffMediaType(data: Buffer): ImageAttachment["mediaType"] | undefined {
  if (startsWith(data, PNG_SIGNATURE)) return "image/png";
  if (startsWith(data, JPEG_SIGNATURE)) return "image/jpeg";
  return undefined;
}

function startsWith(data: Buffer, signature: Buffer): boolean {
  return data.length >= signature.length && data.subarray(0, signature.length).equals(signature);
}
