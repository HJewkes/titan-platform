import { z } from "zod";

export const SMOKE_STAGES = ["tts", "stt", "phones"] as const;
export type SmokeStage = (typeof SMOKE_STAGES)[number];

const seconds = z.number().nonnegative();

const stageModel = {
  device: z.enum(["cpu", "cuda", "coreml", "webgpu"]),
  model: z.string().min(1),
  revision: z.string().min(1),
  dtype: z.string().min(1),
};

const passedStage = z.strictObject({
  ok: z.literal(true),
  ...stageModel,
  loadS: seconds.describe("Cold call minus warm call, in seconds"),
  inferS: seconds.describe("Wall seconds of the warm call"),
  audioS: seconds.describe("Seconds of audio produced (tts) or consumed (stt, phones)"),
  rtf: z
    .number()
    .positive()
    .describe("Real-time factor: audio seconds / wall seconds of the warm call. Above 1 runs faster than real time."),
  maxRssMbAfter: z.number().positive(),
  wavPath: z.string().min(1).optional(),
  words: z.number().int().nonnegative().optional(),
  transcript: z.string().optional(),
  wer: z.number().nonnegative().optional(),
  phones: z.string().optional(),
  frames: z.number().int().nonnegative().optional(),
});

const failedStage = z.strictObject({ ok: z.literal(false), ...stageModel, error: z.string().min(1) });

const stageResult = z.discriminatedUnion("ok", [passedStage, failedStage]);
export type StageResult = z.infer<typeof stageResult>;

const configSource = z.enum(["env", "profile", "default"]);

/** The `pnpm smoke:speech` JSON report, ported from spike E8's smoke.schema.json. */
export const smokeReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  ok: z.boolean(),
  suite: z.array(z.enum(SMOKE_STAGES)).min(1),
  sentence: z.string().min(1),
  voice: z.string().min(1),
  profile: z.string().min(1).nullable().describe("The --profile path, or null"),
  startedAt: z.iso.datetime({ offset: true }),
  host: z.strictObject({
    os: z.string(),
    release: z.string(),
    arch: z.string(),
    cpus: z.number().int().positive(),
    cpuModel: z.string(),
    memGb: z.number().positive(),
  }),
  node: z.string().regex(/^v\d+\.\d+\.\d+/),
  packages: z.record(z.string(), z.string()),
  cache: z.strictObject({ dir: z.string().min(1), source: configSource, usedBytes: z.number().int().nonnegative() }),
  stages: z.strictObject({ tts: stageResult.optional(), stt: stageResult.optional(), phones: stageResult.optional() }),
  maxRssMb: z.number().positive(),
  wallS: seconds,
});
export type SmokeReport = z.infer<typeof smokeReportSchema>;

/** Audio seconds per wall second, to four places. A wall time of zero means a cache hit, not a measurement. */
export function realTimeFactor(audioS: number, wallS: number): number {
  if (!(wallS > 0)) throw new RangeError(`wall time ${wallS}s cannot give a real-time factor; was the call cached?`);
  return Math.round((audioS / wallS) * 10_000) / 10_000;
}
