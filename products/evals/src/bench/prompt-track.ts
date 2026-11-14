import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hashCanonical } from "../hash.js";
import { TRACK_TIMEOUT_SECS, TRACK_TOOLS } from "./args.js";
import type { Track } from "./arms.js";
import type { BenchCase, PreparedJob, TrackPlugin, TrackScore } from "./runner.js";

const PromptCaseSchema = z.strictObject({
  id: z.string().min(1),
  prompt: z.string().min(1),
  claudeMd: z.string().optional(),
  stratum: z.record(z.string(), z.string()).optional(),
});
type PromptCase = z.infer<typeof PromptCaseSchema> & BenchCase;

/** Every `*.json` in the dir, in name order, each one case; the hash covers the whole case. */
export function loadPromptCases(dir: string): PromptCase[] {
  const files = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  return files.map((name) => {
    const parsed = PromptCaseSchema.parse(JSON.parse(readFileSync(join(dir, name), "utf8")));
    return { ...parsed, hash: hashCanonical(parsed) };
  });
}

/**
 * Runs a literal prompt in an empty workspace with the track's tools and timeout. It is the skeleton's track until the
 * track slices bring their own case builders and scorers; the smoke runs through it.
 */
export function promptPlugin(track: Track): TrackPlugin<PromptCase> {
  return {
    track,
    prepare: (benchCase, _arm, jobDir): Promise<PreparedJob> => {
      const cwd = join(jobDir, "ws");
      mkdirSync(cwd, { recursive: true });
      if (benchCase.claudeMd !== undefined) writeFileSync(join(cwd, "CLAUDE.md"), benchCase.claudeMd);
      const prepared = { cwd, prompt: benchCase.prompt, allowedTools: TRACK_TOOLS[track].allowed, timeoutSecs: TRACK_TIMEOUT_SECS[track] };
      return Promise.resolve({ ...prepared, appendSystemPromptFile: join(cwd, "CLAUDE.md") });
    },
    score: (job): Promise<TrackScore> => Promise.resolve({ result: { outcome: job.outcome } }),
    cleanup: () => Promise.resolve(),
  };
}
