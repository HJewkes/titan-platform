import { isAbsolute } from "node:path";
import { RunSettingsSchema } from "@titan-design/autoresearch";
import { z } from "zod";

/** Every host path is local to this machine and never in a repo, so a relative one would resolve against whatever cwd serve has. */
const localPath = z.string().min(1).refine(isAbsolute, "must be an absolute path");
const profile = z.string().regex(/^[A-Za-z0-9._-]+$/, "must be a profile name");

/** One target's local bindings. Validator cases and case names live here, never in the target repo. */
const ArTargetConfigSchema = z.strictObject({
  clone: localPath,
  /** Where `target.json` and `bounds.json` sit, relative to the target repo's root. */
  adapterDir: z
    .string()
    .min(1)
    .refine((dir) => !isAbsolute(dir) && !dir.split("/").includes(".."), "must be a path inside the target repo"),
  /** One case name per line; L0 refuses an added line that names one. */
  caseNamesFile: localPath.optional(),
  /** One held-out case per line, `<case>` or `<case>\t<caseSet>`; milestone looks run these and nothing else. */
  validatorCasesFile: localPath.optional(),
});

/** The model per stage is chosen by profile; there is no per-stage cache TTL, since no spawn path reads one yet. */
const StageSchema = z.strictObject({ profile });

export const ArConfigSchema = z.strictObject({
  agentChatBin: localPath,
  /** The agents account's Claude config directory; every planner and implementer runs on it. */
  configDir: localPath,
  account: z.string().min(1),
  workRoot: localPath,
  archiveDir: localPath,
  registryPath: localPath,
  inboxDir: localPath,
  stages: z.strictObject({ planner: StageSchema, implementer: StageSchema }),
  load: z.strictObject({ ceiling: z.number().positive(), pollMs: z.number().int().positive(), maxWaitMs: z.number().int().positive().optional() }),
  /** The spawn limits file and the pool every autoresearch spawn is admitted against. */
  limits: z.strictObject({ pool: z.string().min(1), path: localPath }),
  /** Run defaults; `autoresearch start` flags override them per run. */
  run: RunSettingsSchema.default(RunSettingsSchema.parse({})),
  targets: z.record(z.string().regex(/^[A-Za-z0-9._-]+$/, "must be a target name"), ArTargetConfigSchema),
});
export type ArConfig = z.infer<typeof ArConfigSchema>;
