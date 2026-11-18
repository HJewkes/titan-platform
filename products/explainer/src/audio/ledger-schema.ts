import { z } from "zod";

export const AUDIO_LEDGER_SCHEMA = "explainer.audio-ledger/v1";

/** The library's one WAV shape: every file is normalised to mono 48 kHz PCM16 at import. */
export const LIBRARY_SAMPLE_RATE = 48_000;

/**
 * The only licences an asset may carry into the library. NC, ND and SA are never accepted: a published video is
 * monetised, edited and not shared alike. CC BY stays out until its attribution policy is settled (TP-3991 Q2).
 */
export const ALLOWED_LICENCES = ["generated-own", "CC0-1.0"] as const;

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);

export const AudioKindSchema = z.enum(["bgm", "sfx"]);
export type AudioKind = z.infer<typeof AudioKindSchema>;

export const AudioSourceSchema = z.object({
  kind: z.enum(["generator", "library", "download", "purchase"]),
  name: z.string().min(1),
  url: z.url().optional(),
});
export type AudioSource = z.infer<typeof AudioSourceSchema>;

const GeneratorSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  seed: z.number().int(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type GeneratorInfo = z.infer<typeof GeneratorSchema>;

const LoopSchema = z.union([z.boolean(), z.object({ startS: z.number().nonnegative(), endS: z.number().positive() })]);

export const LedgerEntrySchema = z.object({
  schema: z.literal(AUDIO_LEDGER_SCHEMA),
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "id must be a kebab slug"),
  kind: AudioKindSchema,
  sha256: SHA256,
  wavSha256: SHA256,
  source: AudioSourceSchema,
  licence: z.enum(ALLOWED_LICENCES),
  creator: z.string().optional(),
  title: z.string().optional(),
  retrievedAt: z.string().min(1),
  durationS: z.number().positive(),
  loudness: z.object({ integratedLufs: z.number(), samplePeakDb: z.number() }),
  tags: z.array(z.string().min(1)),
  loop: LoopSchema.optional(),
  /** Where an SFX's hit lands inside the clip, so it is placed at `cue − anchorS`. */
  anchorS: z.number().nonnegative().optional(),
  generator: GeneratorSchema.optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/** Why an asset may not enter the library, or undefined when its licence is allowed. */
export function licenceRefusal(licence: string): string | undefined {
  if ((ALLOWED_LICENCES as readonly string[]).includes(licence)) return undefined;
  return `licence "${licence}" is not allowed; the library accepts only ${ALLOWED_LICENCES.join(", ")}`;
}
