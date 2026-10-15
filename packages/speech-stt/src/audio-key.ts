import { createHash } from "node:crypto";
import type { Audio } from "./schemas.js";

/** A SHA-256 of `tag` (whatever else decides the output, such as the model), the sample rate and the samples. */
export function audioKey(tag: string, audio: Audio): string {
  const { buffer, byteOffset, byteLength } = audio.samples;
  return createHash("sha256")
    .update(`${tag}\0${audio.sampleRate}\0`)
    .update(new Uint8Array(buffer, byteOffset, byteLength))
    .digest("hex");
}
