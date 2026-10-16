import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ASK_LABEL_PATTERN } from "@titan-design/agent-dispatch";
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
  /** A PR over this many changed lines, generated files left out, gets the g10 profile; absent means 400. */
  g10ChangedLines: z.number().int().positive().optional(),
  configDir: argvWord.refine(isAbsolute, "must be an absolute path").optional(),
  /** Claude config directories a review moves to, in order, while `configDir` is out of usage; absent means the review holds. */
  fallbackConfigDirs: z.array(argvWord.refine(isAbsolute, "must be an absolute path")).optional(),
  verdictTimeoutMs: z.number().int().positive().optional(),
  sessionStartTimeoutMs: z.number().int().positive().optional(),
  /** Repos whose CI uploads a `codewatch-report` artifact; their reviewer briefs get its questions. */
  codewatchRepos: z.array(z.string().refine(isRepoKey, "must be an owner/name repo")).optional(),
  /** The free bytes a review needs on the filesystem that holds review checkouts; absent means 5 GiB. */
  minFreeBytes: z.number().int().min(0).optional(),
  /** The free inodes a review needs, as a percent of that filesystem's, raised to twice the last checkout's; absent means 15. */
  minFreeInodesPct: z.number().min(0).max(100).optional(),
  /** No reviewer starts while this many run; absent means 3. */
  maxConcurrent: z.number().int().positive().optional(),
  /** `shadow` records the review panel's plan on each intent and spawns nothing more; `on` reviews with the panel. Absent means `off`. */
  panel: z.enum(["off", "shadow", "on"]).optional(),
  /** The profile of the adversary member a g10-adversary hold gets under `shepherd.gateReset.twoMergeRelease`; absent means `fable-reviewer`. */
  adversaryProfile: profileName.optional(),
  /** The Claude config directory that adversary member runs under, for account diversity; absent means `configDir`. */
  adversaryConfigDir: argvWord.refine(isAbsolute, "must be an absolute path").optional(),
});

export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;

/** A repo Shepherd works on with no seat behind it; strict, so a misspelt `path` fails the load instead of leaving no checkout. */
export const ShepherdRepoConfigSchema = z.strictObject({
  /** The repo's main checkout, used when no seat binds the repo; a seat's path wins. */
  path: z.string().min(1).optional(),
  /** Shepherd reviews, watches CI and notifies, but never merges, updates the branch or pushes. */
  advisory: z.boolean().optional(),
  /** Opt-in: after Shepherd's own merge, restack the repo's stacked agent-chat children by a fast-forward push. Absent means off. */
  stackRestack: z.boolean().optional(),
});

export type ShepherdRepoConfig = z.infer<typeof ShepherdRepoConfigSchema>;

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

/** An ntfy topic URL that each written slot is pushed to; the optional token file holds a bearer token, never the token itself. */
export const DigestPushConfigSchema = z.strictObject({
  url: z.string().refine((value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol), "must be an http or https URL"),
  tokenFile: absolutePath.optional(),
});

export type DigestPushConfig = z.infer<typeof DigestPushConfigSchema>;

/** The owner digest; queue and log directories default to siblings of `shepherd.seatsDir`. */
export const DigestConfigSchema = z.strictObject({
  outDir: absolutePath.optional(),
  copyDirs: z.array(absolutePath).optional(),
  /** Legacy alias: the Mac's live config still names its one copy destination this way. */
  icloudDir: absolutePath.optional(),
  timezone: z.string().refine(isTimeZone, "must be an IANA time zone").optional(),
  slots: z.array(z.number().int().min(0).max(23)).min(1).optional(),
  /** Where both the digest and the owner-queue reader find the seat Morning files. */
  queuesDir: absolutePath.optional(),
  logsDir: absolutePath.optional(),
  push: DigestPushConfigSchema.optional(),
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
  headroomIntervalMs: z.number().int().min(0).optional(),
  burstMax: z.number().int().positive().optional(),
  headroomReviews: z.number().int().min(0).optional(),
  reviewLoad: z.number().min(0).optional(),
});

/** The launchd label is `<labelPrefix>titan-factory`; absent means `dev.hjewkes.`. Uninstall the service before changing it, or the old job stays loaded under the old label. */
export const ServiceConfigSchema = z.strictObject({
  labelPrefix: noNul.min(1).optional(),
  /** The checkout the service runs from and deploys fast-forward; absent means `<data dir>/deploy/titan-platform`. */
  deployCheckout: absolutePath.optional(),
  /** What deploy clones the checkout from when it is absent; absent means the origin of the checkout the CLI runs from. */
  deployRemote: noNul.min(1).optional(),
  /** How long `service deploy` watches a restarted build before it counts as deployed; absent means 2 minutes. */
  deployWatchMs: z.number().int().min(0).optional(),
});

export type DigestConfig = z.infer<typeof DigestConfigSchema>;

/** How a standing deploy alarm repeats; absent keys keep the defaults, every 6 deploy-watch ticks and 30 minutes. */
export const DeployAlarmConfigSchema = z.strictObject({
  renotifyTicks: z.number().int().positive().optional(),
  escalateAfterMinutes: z.number().int().positive().optional(),
});

/** The GitHub App `shepherd/review` is posted as; absent means the publish step records `published: false`. */
export const ReviewCheckConfigSchema = z.strictObject({
  appId: z.number().int().positive(),
  installationId: z.number().int().positive(),
  privateKeyPath: absolutePath,
});

export type ReviewCheckConfig = z.infer<typeof ReviewCheckConfigSchema>;

/**
 * Posts pending decision gates to agent-chat's human queue and resolves them from the answer (CC-169 g). An answer
 * resolves as `owner-remote` (Q1): any unregistered caller on the broker's 0600 socket can answer, so only gates whose
 * rule admits a remote owner are asked; absent means serve asks nothing.
 */
export const GateNotifyConfigSchema = z.strictObject({
  label: z.string().regex(ASK_LABEL_PATTERN, "must be an agent-chat ask label").default("titan-factory"),
  resolverClass: z.enum(["owner-remote", "owner-terminal"]).default("owner-remote"),
});

export type GateNotifyConfig = z.infer<typeof GateNotifyConfigSchema>;

function isRemoteFactoryUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
}

/** The factory that owns the live database; with it set, this host's database is frozen and no verb writes a gate here. */
const remoteFactoryUrl = z.string().refine(isRemoteFactoryUrl, "must be an http or https URL with no credentials");

/** The schema strips unknown keys, so a misspelt remoteFactory would silently leave the frozen database writable. */
const misspeltRemoteFactory = (key: string): boolean => key !== "remoteFactory" && key.toLowerCase().replace(/[^a-z]/g, "").startsWith("remotefactory");

/** Owner-specific bindings live here, outside the public repo; later slices add repos and device keys. */
export const FactoryConfigSchema = z.object({
  dbPath: z.string().min(1).optional(),
  remoteFactory: remoteFactoryUrl.optional(),
  postMerge: PostMergeConfigSchema.optional(),
  digest: DigestConfigSchema.optional(),
  service: ServiceConfigSchema.optional(),
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
      repos: z.record(z.string().refine(isRepoKey, "must be an owner/name repo"), ShepherdRepoConfigSchema).optional(),
      reviewCheck: ReviewCheckConfigSchema.optional(),
      /** The agent-chat seat told when the deploy alarm goes up and while it stands; absent is warned about at serve start and fails `service check`. */
      hubSeat: z.string().min(1).optional(),
      deployAlarm: DeployAlarmConfigSchema.optional(),
      gateNotify: GateNotifyConfigSchema.optional(),
      /**
       * Decisions 422 and 423's stopgaps, each off when absent. `twoMergeRelease` other than `off` gives a g10-adversary hold Shepherd's
       * own adversary member; `shadow` records where that member's MERGE and the correctness MERGE would release the hold, `on` releases it.
       * `heldRepair: on` lets a g10 hold gate only the merge, so its run repairs as usual.
       */
      gateReset: z.strictObject({ twoMergeRelease: z.enum(["off", "shadow", "on"]).optional(), heldRepair: z.enum(["off", "on"]).optional() }).optional(),
    })
    .refine((s) => !s.hardStopRepos || s.charterPath, { message: "hardStopRepos needs a charterPath", path: ["charterPath"] })
    .refine((s) => !s.review || s.agentChatBin, { message: "review needs an agentChatBin", path: ["agentChatBin"] })
    .refine((s) => !s.fixer || s.agentChatBin, { message: "fixer needs an agentChatBin", path: ["agentChatBin"] })
    .refine((s) => !s.hubSeat || s.agentChatBin, { message: "hubSeat needs an agentChatBin", path: ["agentChatBin"] })
    .refine((s) => !s.gateNotify || s.agentChatBin, { message: "gateNotify needs an agentChatBin", path: ["agentChatBin"] })
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
  return readConfig(path) ?? {};
}

/** Like `loadConfig`, but undefined when no file is there, so a caller can tell an absent file from one that sets nothing. */
export function readConfig(path: string): FactoryConfig | undefined {
  if (!existsSync(path)) return undefined;
  const raw = parseJson(path);
  const misspelt = raw && typeof raw === "object" ? Object.keys(raw).find(misspeltRemoteFactory) : undefined;
  if (misspelt) throw new Error(`invalid config ${path}: ${misspelt}: did you mean remoteFactory?`);
  const parsed = FactoryConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid config ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/** `--db`, then `TITAN_FACTORY_DB`, then the config file, then the XDG state default. */
export function resolveDbPath(sources: ConfigSources): string {
  return sources.dbFlag ?? sources.env.TITAN_FACTORY_DB ?? loadConfig(configPath(sources.env)).dbPath ?? defaultDbPath(sources.env);
}
