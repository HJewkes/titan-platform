import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Opus-class since the TP-3911 A/B: two Opus replays of a recorded Fable wake proposed the same five slices.
 * opus-coordinator is the only Opus profile that keeps `agent-chat burndown` and `agent ls`, which the review reads.
 */
const DEFAULT_PLANNER_PROFILE = "opus-coordinator";
/** Owner decision 522 (cost-week-2026-10-21 §10.3): a pre-digested planner input stays at or under 60k tokens. */
const DEFAULT_DIGEST_MAX_TOKENS = 60_000;

const InputSchema = z
  .object({
    name: z.string().min(1),
    file: z.string().optional(),
    dir: z.string().optional(),
    suffix: z.string().default(""),
    command: z.array(z.string()).min(1).optional(),
    /** The planner writes this input itself, so its own last run's edits are not news. */
    selfWritten: z.boolean().default(false),
    dropSections: z.array(z.string()).default([]),
    /** Copied into the digest the planner reads first; tailLines keeps only the end. */
    digest: z.boolean().default(false),
    tailLines: z.number().int().positive().optional(),
  })
  .refine((input) => [input.file, input.dir, input.command].filter((source) => source !== undefined).length === 1, {
    message: "each input names exactly one of file, dir or command",
  });

const PlannerConfigSchema = z.object({
  name: z.string().min(1).default("factory-planner"),
  profile: z.string().min(1).default(DEFAULT_PLANNER_PROFILE),
  configDir: z.string().optional(),
  role: z.string().default("planner"),
  cwd: z.string().min(1),
  brief: z.string().min(1),
  agentChat: z.string().default("agent-chat"),
  digestMaxTokens: z.number().int().positive().default(DEFAULT_DIGEST_MAX_TOKENS),
  inputs: z.array(InputSchema).min(1),
});

export type PlannerConfig = z.infer<typeof PlannerConfigSchema>;
export type PlannerInput = PlannerConfig["inputs"][number];

export function loadPlannerConfig(path: string): PlannerConfig {
  const parsed = PlannerConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`planner config ${path}: ${issue?.path.join(".") ?? ""} ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}
