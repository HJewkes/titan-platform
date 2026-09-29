import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { isRepoKey } from "./shepherd/seats.js";

/** Owner-specific bindings live here, outside the public repo; later slices add repos, device and post-merge keys. */
export const FactoryConfigSchema = z.object({
  dbPath: z.string().min(1).optional(),
  shepherd: z
    .object({
      seatsDir: z.string().min(1).optional(),
      charterPath: z.string().min(1).optional(),
      hardStopRepos: z.record(z.string().min(1), z.array(z.string().refine(isRepoKey, "must be an owner/name repo"))).optional(),
    })
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

export function loadConfig(path: string): FactoryConfig {
  if (!existsSync(path)) return {};
  const parsed = FactoryConfigSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`invalid config ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

/** `--db`, then `TITAN_FACTORY_DB`, then the config file, then the XDG state default. */
export function resolveDbPath(sources: ConfigSources): string {
  return sources.dbFlag ?? sources.env.TITAN_FACTORY_DB ?? loadConfig(configPath(sources.env)).dbPath ?? defaultDbPath(sources.env);
}
