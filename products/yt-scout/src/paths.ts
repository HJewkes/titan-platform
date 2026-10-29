import os from "node:os";
import path from "node:path";
import { activeWorkRoot, type PathOptions } from "@titan-design/app-paths";

/** The youtube initiative's sources tree: `YT_ROOT`, else `<active-work root>/youtube/sources`. */
export function ytRoot(opts: PathOptions = {}): string {
  const env = opts.env ?? process.env;
  if (env.YT_ROOT) return path.resolve(env.YT_ROOT);
  return path.join(activeWorkRoot(opts), "youtube", "sources");
}

/** The owner-edited watch list: `TITAN_YT_SCOUT_CONFIG`, else `<yt root>/scout/watchlist.yml`. */
export function configPath(opts: PathOptions = {}): string {
  const env = opts.env ?? process.env;
  if (env.TITAN_YT_SCOUT_CONFIG) return path.resolve(env.TITAN_YT_SCOUT_CONFIG);
  return path.join(ytRoot(opts), "scout", "watchlist.yml");
}

/** Scout state lives outside the initiative tree, beside the timers' other state. */
export function dbPath(opts: PathOptions = {}): string {
  const env = opts.env ?? process.env;
  if (env.TITAN_YT_SCOUT_DB) return path.resolve(env.TITAN_YT_SCOUT_DB);
  const stateHome = env.XDG_STATE_HOME || path.join(opts.home ?? os.homedir(), ".local", "state");
  return path.join(stateHome, "titan-yt-scout", "scout.sqlite3");
}

/** Step rows (plan section 5) sit beside the scout database. */
export function rowsDir(opts: PathOptions = {}): string {
  return path.join(path.dirname(dbPath(opts)), "rows");
}
