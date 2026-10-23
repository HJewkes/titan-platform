import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodeWav, encodeWav, type Audio } from "@titan-design/speech-tts";
import { z } from "zod";
import { canonicalJson } from "../eval-store.js";
import { sha256 } from "./artifacts.js";

/**
 * What makes a beat's audio: the text, the voice, the words a minute it was calibrated to and the engine build.
 * Planned length and padding are not in it.
 */
interface TakeKey {
  spoken: string;
  voice: string;
  rateWpm: number;
  engine: string;
}

export const takeKey = (key: TakeKey): string =>
  sha256(canonicalJson({ spoken: key.spoken, voice: key.voice, rateWpm: key.rateWpm, engine: key.engine }));

const TakeMetaSchema = z.object({
  words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })),
  speed: z.number(),
  wpm: z.number(),
});
type TakeMeta = z.infer<typeof TakeMetaSchema>;

/** One synthesis: the unpadded speech, the engine's own word times, and the speed that reached the measured rate. */
export interface Take extends TakeMeta {
  audio: Audio;
}

/**
 * `<dir>/<key>.wav` and `<key>.json`: one beat's take, so a rerun of an unchanged beat never re-synthesizes. Kokoro
 * does not repeat its audio byte for byte, so this cache, not the stage key, is what keeps a re-voiced script's
 * untouched beats identical.
 */
export class TakeCache {
  constructor(private readonly dir: string) {}

  get(key: string): Take | undefined {
    const wav = path.join(this.dir, `${key}.wav`);
    const meta = path.join(this.dir, `${key}.json`);
    if (!existsSync(wav) || !existsSync(meta)) return undefined;
    return { audio: decodeWav(readFileSync(wav)), ...TakeMetaSchema.parse(JSON.parse(readFileSync(meta, "utf8"))) };
  }

  put(key: string, take: Take): void {
    mkdirSync(this.dir, { recursive: true });
    // The meta file lands last, so a crash between the two leaves a miss, never a take with no words.
    atomicWrite(path.join(this.dir, `${key}.wav`), encodeWav(take.audio));
    atomicWrite(path.join(this.dir, `${key}.json`), `${JSON.stringify({ words: take.words, speed: take.speed, wpm: take.wpm })}\n`);
  }
}

function atomicWrite(file: string, bytes: Uint8Array | string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
}
