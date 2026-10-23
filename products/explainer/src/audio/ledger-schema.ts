import { z } from "zod";

export const AUDIO_LEDGER_SCHEMA = "explainer.audio-ledger/v1";

/**
 * The only licences an asset may carry into the library. NC, ND and SA are never accepted: a published video is
 * monetised, edited and not shared alike. Narrowing this list is the whole of a licence-policy change.
 */
export const ALLOWED_LICENCES = ["CC0-1.0", "CC-BY-4.0", "generated-own"] as const;
export type AudioLicence = (typeof ALLOWED_LICENCES)[number];

/** Licences whose terms require a credit line in every published video. */
export const ATTRIBUTION_LICENCES: ReadonlySet<string> = new Set<AudioLicence>(["CC-BY-4.0"]);

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);

export const AudioKindSchema = z.enum(["bgm", "sfx"]);
export type AudioKind = z.infer<typeof AudioKindSchema>;

export const AudioSourceSchema = z.object({
  kind: z.enum(["generator", "library", "download", "purchase"]),
  name: z.string().min(1),
  url: z.url().optional(),
});
export type AudioSource = z.infer<typeof AudioSourceSchema>;

export const GeneratorSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  seed: z.number().int(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type GeneratorInfo = z.infer<typeof GeneratorSchema>;

export const LoopSchema = z.union([z.boolean(), z.object({ startS: z.number().nonnegative(), endS: z.number().positive() })]);

export const LedgerEntrySchema = z.object({
  schema: z.literal(AUDIO_LEDGER_SCHEMA),
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "id must be a kebab slug"),
  kind: AudioKindSchema,
  sha256: SHA256,
  wavSha256: SHA256,
  source: AudioSourceSchema,
  licence: z.enum(ALLOWED_LICENCES),
  attribution: z.string().min(1).optional(),
  creator: z.string().optional(),
  title: z.string().optional(),
  retrievedAt: z.string().min(1),
  durationS: z.number().positive(),
  loudness: z.object({ integratedLufs: z.number(), truePeakDb: z.number() }),
  tags: z.array(z.string().min(1)),
  loop: LoopSchema.optional(),
  /** Where an SFX's hit lands inside the clip, so it is placed at `cue − anchorS`. */
  anchorS: z.number().nonnegative().optional(),
  generator: GeneratorSchema.optional(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/** Why an asset may not enter the library, or undefined when its licence terms are met. */
export function licenceRefusal(licence: string, attribution: string | undefined): string | undefined {
  if (!(ALLOWED_LICENCES as readonly string[]).includes(licence)) {
    return `licence "${licence}" is not allowed; the library accepts only ${ALLOWED_LICENCES.join(", ")}`;
  }
  if (ATTRIBUTION_LICENCES.has(licence) && !attribution?.trim()) {
    return `licence "${licence}" requires an attribution line; pass the exact credit`;
  }
  return undefined;
}
