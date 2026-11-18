import { execFile } from "node:child_process";
import { z } from "zod";

/**
 * One Shepherd run's stage minutes and review rounds, as `titan-factory shepherd stats --per-run --json` prints them.
 * Factory owns how a step maps to a stage and how a head counts as a review round, so the job asks it over the CLI
 * rather than copying that policy.
 */
const PerRunRecord = z.object({
  runId: z.string(),
  repo: z.string(),
  status: z.string(),
  completedAt: z.string().nullable(),
  stageMinutes: z.record(z.string(), z.number()),
  reviewRounds: z.number(),
});
export type PerRunRecord = z.infer<typeof PerRunRecord>;

const PerRunOutput = z.object({ perRun: z.array(PerRunRecord) });

/** Reads the per-run records; null when factory could not answer, which reads as not measured. */
export type PerRunSource = (factoryDb: string) => Promise<PerRunRecord[] | null>;

const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

/** The factory CLI on PATH, run read-only against the same database the job reads. */
export const factoryPerRunCli: PerRunSource = (factoryDb) =>
  new Promise((resolve) => {
    execFile("titan-factory", ["--db", factoryDb, "shepherd", "stats", "--per-run", "--json"], { maxBuffer: MAX_OUTPUT_BYTES }, (error, stdout) => {
      if (error !== null) return resolve(null);
      try {
        resolve(PerRunOutput.parse(JSON.parse(stdout)).perRun);
      } catch {
        resolve(null);
      }
    });
  });
