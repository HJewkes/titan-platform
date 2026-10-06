import { z } from "zod";

export const MAX_WORKER_REPORT_LENGTH = 2000;

const count = z.number().int().nonnegative();

/** The producer truncates to the cap; the schema rejects what is over it. */
const WorkerReportSchema = z.strictObject({
  messageId: z.string().min(1),
  kind: z.enum(["status", "verdict"]),
  text: z.string().max(MAX_WORKER_REPORT_LENGTH),
});

const WorkerPrSchema = z.strictObject({
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  number: z.number().int().positive(),
});

/** Same fields agent-chat's on_complete sends today, minus the agent id. */
const WorkerExitSchema = z.strictObject({
  code: z.number().int().nullable(),
  signal: z.string().min(1).nullable(),
  inferred: z.boolean(),
});

/** What a spawned worker's completion carries. A no-report exit is valid and has only exit facts. */
export const WorkerFactsSchema = z.strictObject({
  agent: z.string().min(1),
  profile: z.string().min(1),
  spawner: z.string().min(1),
  taskId: z.string().min(1).nullish(),
  report: WorkerReportSchema.nullish(),
  pr: WorkerPrSchema.nullish(),
  tokens: z.strictObject({ input: count, output: count, total: count }).nullish(),
  costUsd: z.number().nonnegative().nullish(),
  exit: WorkerExitSchema,
});

export type WorkerFacts = z.infer<typeof WorkerFactsSchema>;
