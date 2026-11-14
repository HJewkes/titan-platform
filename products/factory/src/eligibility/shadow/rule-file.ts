import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { configPath } from "../../config.js";
import { errorMessage } from "../../narrow.js";
import { RELAXATIONS, SEVERITIES } from "../intake.js";

/*
 * The dispatcher rule file (`titan-dispatcher/v1`, TP-5755 PLAN 5.4): owner-held policy as data, outside the repo.
 * `mode` admits only "shadow", so no value of this file can express live dispatch.
 */

const LaneSchema = z.object({ initiative: z.string().min(1), tag: z.string().min(1).nullable().default(null) });

const ShadowSchema = z.object({ enabled: z.boolean().default(false), dir: z.string().min(1).optional() }).refine((shadow) => !shadow.enabled || shadow.dir !== undefined, {
  message: "an enabled shadow needs a dir",
  path: ["dir"],
});

/** Keys later slices read (PLAN 5.4) are accepted now so the owner's full example file parses; nothing reads them yet. */
const PLANNED_KEYS = { bets: z.unknown().optional() };

const INTAKE_DEFAULTS = { minSeverity: "medium", expireDays: 28 } as const;

const IntakeSchema = z
  .object({ minSeverity: z.enum(SEVERITIES).default(INTAKE_DEFAULTS.minSeverity), expireDays: z.number().int().positive().default(INTAKE_DEFAULTS.expireDays) })
  .strict()
  .default(INTAKE_DEFAULTS);

const count = z.number().int().positive();
const factor = z.number().positive();

/** The stop rules' thresholds (TP-5755 PLAN 2.4); each key absent takes the operating model's starting value. */
const StopSchema = z
  .object({
    taskFixRounds: count.default(3),
    spendMultiple: factor.default(2),
    usdPerPoint: factor.default(8),
    betStoppedPrs: count.default(3),
    betFollowupMultiple: factor.default(2),
    checkpointEvery: count.default(5),
  })
  .strict();

export type StopRules = z.infer<typeof StopSchema>;

/** The upkeep cap (TP-5755 PLAN 2.2); `factoryOutcomes` names the outcomes whose untagged tasks count as upkeep. */
const UpkeepSchema = z
  .object({
    capShare: z.number().gt(0).max(1).default(0.25),
    windowDays: count.default(7),
    factoryOutcomes: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type UpkeepRules = z.infer<typeof UpkeepSchema>;

/** Whose spawns the shadow is scored against, and how a bare task id such as `TP-1` finds its initiative. */
const CompareSchema = z
  .object({
    operator: z.string().min(1).default("tp-operator"),
    prefixes: z.record(z.string().min(1), z.string().min(1)).default({ TP: "titan-platform" }),
  })
  .optional();

type CompareSettings = Required<NonNullable<z.infer<typeof CompareSchema>>>;

/** The compare keys with their defaults filled, so a rule file without a `compare` block scores against tp-operator. */
export function compareSettings(rules: { compare?: z.infer<typeof CompareSchema> }): CompareSettings {
  return { operator: rules.compare?.operator ?? "tp-operator", prefixes: rules.compare?.prefixes ?? { TP: "titan-platform" } };
}

const RuleFileSchema = z
  .object({
    schema: z.literal("titan-dispatcher/v1"),
    mode: z.literal("shadow"),
    shadow: ShadowSchema.default({ enabled: false }),
    lanes: z.array(LaneSchema).default([]),
    /** Strict checks the shadow waives while filers do not yet set the fields; each waived pass is labelled on its row. */
    relax: z.array(z.enum(RELAXATIONS)).default([]),
    intake: IntakeSchema,
    stop: StopSchema.prefault({}),
    upkeep: UpkeepSchema.prefault({}),
    compare: CompareSchema,
    ...PLANNED_KEYS,
  })
  .strict();

export type RuleFile = z.infer<typeof RuleFileSchema>;

export type ShadowLane = RuleFile["lanes"][number];

export interface LoadedRules {
  rules: RuleFile;
  /** `sha256:<hex>` of the file's bytes, so each wake row names the exact policy it ran under. */
  hash: string;
}

/** `dispatcher.json` beside the factory's `config.json`, so `TITAN_FACTORY_CONFIG` moves both. */
export function defaultRuleFilePath(env: NodeJS.ProcessEnv): string {
  return join(dirname(configPath(env)), "dispatcher.json");
}

/** Undefined when the file is absent; throws with the file path when it does not parse. */
export function loadRuleFile(path: string): LoadedRules | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not JSON: ${errorMessage(error)}`);
  }
  const parsed = RuleFileSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${path}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`).join("; ")}`);
  return { rules: parsed.data, hash: `sha256:${createHash("sha256").update(text).digest("hex")}` };
}
