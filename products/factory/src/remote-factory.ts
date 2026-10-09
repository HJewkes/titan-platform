import { configPath, loadConfig } from "./config.js";

/**
 * Verbs that write runs or gates, refused before any probe or RPC: a serve answering `--port` on this host
 * may be the frozen one, and nothing yet proves it is the remote.
 */
export const FROZEN_HOST_WRITE_VERBS: ReadonlySet<string> = new Set([
  "serve",
  "resume",
  "land",
  "gate resolve",
  "gate resolve-batch",
  "shepherd register",
  "shepherd hold",
  "shepherd release",
  "shepherd resync",
]);

export class FrozenHostError extends Error {}

/**
 * Throws when the config names a `remoteFactory`. It ignores `--db` and `TITAN_FACTORY_DB`, because a write
 * to the frozen copy is lost wherever it points.
 */
export function refuseFrozenHost(env: NodeJS.ProcessEnv, verb: string): void {
  const remote = loadConfig(configPath(env)).remoteFactory;
  if (!remote) return;
  throw new FrozenHostError(`${verb} refused: this host's database is frozen; the live factory is ${remote}. Run it on that host; nothing was written here.`);
}
