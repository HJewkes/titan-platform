import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { isRepoKey } from "./shepherd/seats.js";

/** execFile throws on a NUL byte, which would fail the post-merge step after the merge instead of at config load. */
const noNul = z.string().refine((value) => !value.includes("\0"), "must not contain a NUL byte");
const absolutePath = noNul.refine(isAbsolute, "must be an absolute path");

/** The chore land-pr runs after a merge; strict, so a `shell` or `command` key fails the load instead of being ignored. */
export const PostMergeConfigSchema = z.strictObject({
  argv: z.tuple([noNul.min(1, "argv[0] must name a program")], noNul),
  cwd: absolutePath.optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export type PostMergeConfig = z.infer<typeof PostMergeConfigSchema>;

/** Reaches the agent-chat argv as one literal argument, so a value that reads as a flag or holds whitespace is refused. */
const argvWord = noNul.regex(/^[^-\s]\S*$/, "must be one argument: not empty, no leading dash, no whitespace");

/** The reviewer Shepherd dispatches; strict, so a misspelt timeout fails the load instead of leaving the default in force. */
const profileName = argvWord.refine((v) => !v.includes("/") && !v.includes(".."), "must not contain a slash or ..");

export const ReviewConfigSchema = z.strictObject({
  profile: profileName,
  /** The profile per PR class; a class left out, or no table at all, uses `profile`. */
  roles: z.strictObject({ g10: profileName.optional(), standard: profileName.optional() }).optional(),
  configDir: argvWord.refine(isAbsolute, "must be an absolute path").optional(),
  verdictTimeoutMs: z.number().int().positive().optional(),
  sessionStartTimeoutMs: z.number().int().positive().optional(),
  /** Repos whose CI uploads a `codewatch-report` artifact; their reviewer briefs get its questions. */
  codewatchRepos: z.array(z.string().refine(isRepoKey, "must be an owner/name repo")).optional(),
});

export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;

/** The fixer a red main spawns; `configDir` picks the Claude account it runs under. */
export const FixerConfigSchema = z.strictObject({
  configDir: argvWord.refine(isAbsolute, "must be an absolute path").optional(),
});

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The owner digest; queue and log directories default to siblings of `shepherd.seatsDir`. */
export const DigestConfigSchema = z.strictObject({
  outDir: absolutePath.optional(),
  copyDirs: z.array(absolutePath).optional(),
  /** Legacy alias: the Mac's live config still names its one copy destination this way. */
  icloudDir: absolutePath.optional(),
  timezone: z.string().refine(isTimeZone, "must be an IANA time zone").optional(),
  slots: z.array(z.number().int().min(0).max(23)).min(1).optional(),
  queuesDir: absolutePath.optional(),
  logsDir: absolutePath.optional(),
});

/** Per repo, the required checks a rerun may clear before any wake, and how long to wait before that rerun. */
export const FlakyChecksSchema = z.strictObject({
  checks: z.array(z.string().min(1)).min(1),
  /** Below the ci-wait route's own 45 minute timeout, which the wait, the rerun and the settle all run inside. */
  waitSeconds: z.number().int().min(0).max(900),
});

/** Overrides of the machine limits a factory spawn must pass; the defaults are the seat values. */
export const SpawnGateConfigSchema = z.strictObject({
  load5: z.number().positive().optional(),
  buildLoad5: z.number().positive().optional(),
  pressureLevel: z.number().int().positive().optional(),
  freeMemoryPct: z.number().min(0).max(100).optional(),
  windowMs: z.number().int().min(0).optional(),
  reviewLoad: z.number().min(0).optional(),
});

export type DigestConfig = z.infer<typeof DigestConfigSchema>;

/** The GitHub App `shepherd/review` is posted as; absent means the publish step records `published: false`. */
export const ReviewCheckConfigSchema = z.strictObject({
  appId: z.number().int().positive(),
  installationId: z.number().int().positive(),
  privateKeyPath: absolutePath,
});

export type ReviewCheckConfig = z.infer<typeof ReviewCheckConfigSchema>;

/** Owner-specific bindings live here, outside the public repo; later slices add repos and device keys. */
export const FactoryConfigSchema = z.object({
  dbPath: z.string().min(1).optional(),
  postMerge: PostMergeConfigSchema.optional(),
  digest: DigestConfigSchema.optional(),
  shepherd: z
    .object({
      seatsDir: z.string().min(1).optional(),
      charterPath: z.string().min(1).optional(),
      hardStopRepos: z.record(z.string().min(1), z.array(z.string().refine(isRepoKey, "must be an owner/name repo"))).optional(),
      agentChatBin: absolutePath.optional(),
      review: ReviewConfigSchema.optional(),
      fixer: FixerConfigSchema.optional(),
      spawnGate: SpawnGateConfigSchema.optional(),
      flakyChecks: z.record(z.string().refine(isRepoKey, "must be an owner/name repo"), FlakyChecksSchema).optional(),
      reviewCheck: ReviewCheckConfigSchema.optional(),
      /** The agent-chat seat told once when the deploy alarm goes up; absent means the alarm shows only in status. */
      hubSeat: z.string().min(1).optional(),
    })
    .refine((s) => !s.hardStopRepos || s.charterPath, { message: "hardStopRepos needs a charterPath", path: ["charterPath"] })
    .refine((s) => !s.review || s.agentChatBin, { message: "review needs an agentChatBin", path: ["agentChatBin"] })
    .refine((s) => !s.fixer || s.agentChatBin, { message: "fixer needs an agentChatBin", path: ["agentChatBin"] })
    .refine((s) => !s.hubSeat || s.agentChatBin, { message: "hubSeat needs an agentChatBin", path: ["agentChatBin"] })
    .optional(),
});

export type FactoryConfig = z.infer<typeof FactoryConfigSchema>;

export interface ConfigSources {
  env: NodeJS.ProcessEnv;
  /** The `--db` flag, which beats every other source. */
  dbFlag?: string;
}

export function configPath(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "titan-factory", "config.json");
}

/** Holds the default database, the service logs and the deployer's lock, backups and record. */
export function factoryStateDir(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "titan-factory");
}

export function defaultDbPath(env: NodeJS.ProcessEnv): string {
  return join(factoryStateDir(env), "factory.sqlite3");
}

function parseJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadConfig(path: string): FactoryConfig {
  if (!existsSync(path)) return {};
  const parsed = FactoryConfigSchema.safeParse(parseJson(path));
  if (!parsed.success) throw new Error(`invalid config ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/** `--db`, then `TITAN_FACTORY_DB`, then the config file, then the XDG state default. */
export function resolveDbPath(sources: ConfigSources): string {
  return sources.dbFlag ?? sources.env.TITAN_FACTORY_DB ?? loadConfig(configPath(sources.env)).dbPath ?? defaultDbPath(sources.env);
}
