import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { decodeWav } from "@titan-design/speech-tts";
import { sha256 } from "../workflow/artifacts.js";
import { measureLoudness, normaliseToWav, spawnFfmpeg, type FfmpegExec } from "./ffmpeg.js";
import {
  AUDIO_LEDGER_SCHEMA,
  LedgerEntrySchema,
  licenceRefusal,
  type AudioKind,
  type AudioSource,
  type GeneratorInfo,
  type LedgerEntry,
} from "./ledger-schema.js";

export const AUDIO_LIBRARY_ENV = "EXPLAINER_AUDIO_LIBRARY";

/** `--audio-library` wins, then `EXPLAINER_AUDIO_LIBRARY`, then `<dataDir>/audio-library`. */
export function audioLibraryDir(dataDir: string, override?: string, env: NodeJS.ProcessEnv = process.env): string {
  return override ?? env[AUDIO_LIBRARY_ENV] ?? path.join(dataDir, "audio-library");
}

export const libraryPaths = (dir: string) => ({
  ledger: path.join(dir, "ledger.jsonl"),
  original: (sha: string, ext: string) => path.join(dir, "originals", `${sha}${ext}`),
  wav: (sha: string) => path.join(dir, "wav", `${sha}.wav`),
});

/** Every entry, in import order; a line that fails the schema names its line number. */
export function readLedger(dir: string): LedgerEntry[] {
  const file = libraryPaths(dir).ledger;
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap((line, n) => {
    if (!line.trim()) return [];
    const parsed = LedgerEntrySchema.safeParse(JSON.parse(line));
    if (!parsed.success) throw new Error(`${file}:${n + 1}: ${parsed.error.issues[0]?.message ?? "invalid entry"}`);
    return [parsed.data];
  });
}

export interface ImportRequest {
  file: string;
  id: string;
  kind: AudioKind;
  source: AudioSource;
  licence: string;
  attribution?: string;
  creator?: string;
  title?: string;
  tags?: readonly string[];
  loop?: LedgerEntry["loop"];
  anchorS?: number;
  generator?: GeneratorInfo;
}

export interface ImportDeps {
  exec?: FfmpegExec;
  now?: () => Date;
}

export interface ImportResult {
  entry: LedgerEntry;
  /** False when the file's sha was already in the ledger: the import was a no-op. */
  added: boolean;
}

export class ImportRefused extends Error {}

function existingFor(ledger: readonly LedgerEntry[], request: ImportRequest, sha: string): LedgerEntry | undefined {
  const same = ledger.find((entry) => entry.sha256 === sha);
  if (same) return same;
  if (ledger.some((entry) => entry.id === request.id)) throw new ImportRefused(`id "${request.id}" already names a different file`);
  return undefined;
}

/** Normalises into `wav/<sha>.wav` through a temp name, so a failed ffmpeg never leaves a partial WAV behind. */
async function normalised(dir: string, original: string, sha: string, exec: FfmpegExec): Promise<{ wavSha256: string; durationS: number }> {
  const target = libraryPaths(dir).wav(sha);
  mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  await normaliseToWav(original, partial, exec);
  renameSync(partial, target);
  const bytes = readFileSync(target);
  const audio = decodeWav(bytes);
  return { wavSha256: sha256(bytes), durationS: audio.samples.length / audio.sampleRate };
}

function entryFor(request: ImportRequest, sha: string, measured: Pick<LedgerEntry, "wavSha256" | "durationS" | "loudness">, now: Date): LedgerEntry {
  const optional = {
    ...(request.attribution === undefined ? {} : { attribution: request.attribution }),
    ...(request.creator === undefined ? {} : { creator: request.creator }),
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.loop === undefined ? {} : { loop: request.loop }),
    ...(request.anchorS === undefined ? {} : { anchorS: request.anchorS }),
    ...(request.generator === undefined ? {} : { generator: request.generator }),
  };
  return LedgerEntrySchema.parse({
    schema: AUDIO_LEDGER_SCHEMA, id: request.id, kind: request.kind, sha256: sha, source: request.source, licence: request.licence,
    retrievedAt: now.toISOString(), tags: [...(request.tags ?? [])], ...measured, ...optional,
  });
}

/**
 * Adds one file to the library: the original under `originals/`, a normalised WAV under `wav/` and a ledger line.
 * Refuses a licence outside the allowlist or a CC BY file with no attribution; a sha already in the ledger is a no-op.
 */
export async function importAudio(dir: string, request: ImportRequest, deps: ImportDeps = {}): Promise<ImportResult> {
  const refusal = licenceRefusal(request.licence, request.attribution);
  if (refusal) throw new ImportRefused(refusal);
  const bytes = readFileSync(request.file);
  const sha = sha256(bytes);
  const existing = existingFor(readLedger(dir), request, sha);
  if (existing) return { entry: existing, added: false };
  const exec = deps.exec ?? spawnFfmpeg;
  const original = libraryPaths(dir).original(sha, path.extname(request.file).toLowerCase());
  mkdirSync(path.dirname(original), { recursive: true });
  copyFileSync(request.file, original);
  const { wavSha256, durationS } = await normalised(dir, original, sha, exec);
  const loudness = await measureLoudness(libraryPaths(dir).wav(sha), exec);
  if (!Number.isFinite(loudness.truePeakDb)) throw new ImportRefused(`${path.basename(request.file)} is silent`);
  const entry = entryFor(request, sha, { wavSha256, durationS, loudness }, (deps.now ?? (() => new Date()))());
  appendFileSync(libraryPaths(dir).ledger, `${JSON.stringify(entry)}\n`);
  return { entry, added: true };
}
