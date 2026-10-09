import { configPath, loadConfig } from "./config.js";

/**
 * The refusal a gate-writing verb prints when the config names a `remoteFactory`, else undefined.
 * It ignores `--db` and `TITAN_FACTORY_DB`, because a resolve on the frozen copy is lost wherever it points.
 */
export function remoteFactoryRefusal(env: NodeJS.ProcessEnv, verb: string): string | undefined {
  const remote = loadConfig(configPath(env)).remoteFactory;
  if (!remote) return undefined;
  return `error: ${verb} refused: this host's database is frozen; the live factory is ${remote}. Run it on that host; nothing was written here.\n`;
}
