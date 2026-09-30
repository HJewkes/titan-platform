import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { isRepoKey } from "./shepherd/seats.js";

/** execFile throws on a NUL byte, which would fail the post-merge step after the merge instead of at config load. */
const noNul = z.string().refine((value) => !value.includes("\0"), "must not contain a NUL byte");

/** The chore land-pr runs after a merge; strict, so a `shell` or `command` key fails the load instead of being ignored. */
export const PostMergeConfigSchema = z.strictObject({
  argv: z.tuple([noNul.min(1, "argv[0] must name a program")], noNul),
  cwd: noNul.refine(isAbsolute, "must be an absolute path").optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export type PostMergeConfig = z.infer<typeof PostMergeConfigSchema>;

/** Owner-specific bindings live here, outside the public repo; later slices add repos and device keys. */
export const FactoryConfigSchema = z.object({
  dbPath: z.string().min(1).optional(),
  postMerge: PostMergeConfigSchema.optional(),
  shepherd: z
    .object({
      seatsDir: z.string().min(1).optional(),
      charterPath: z.string().min(1).optional(),
      hardStopRepos: z.record(z.string().min(1), z.array(z.string().refine(isRepoKey, "must be an owner/name repo"))).optional(),
    })
    .refine((s) => !s.hardStopRepos || s.charterPath, { message: "hardStopRepos needs a charterPath", path: ["charterPath"] })
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

export function defaultDbPath(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "titan-factory", "factory.sqlite3");
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
