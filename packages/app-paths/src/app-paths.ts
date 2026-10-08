import os from "node:os";
import path from "node:path";

/** Where to read the environment from. Each field defaults to the current process. */
export interface PathOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  platform?: NodeJS.Platform;
}

/** The per-user directories env-paths gives an app with `{ suffix: "" }`. */
export interface AppDirs {
  data: string;
  config: string;
  cache: string;
  log: string;
}

/** An app whose data root a non-empty environment variable may override. */
export interface AppSpec {
  name: string;
  overrideVar: string;
}

export const ACTIVE_WORK: AppSpec = { name: "active-work", overrideVar: "ACTIVE_ROOT" };

interface Resolved {
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  platform: NodeJS.Platform;
}

function resolveOptions(opts: PathOptions): Resolved {
  return {
    env: opts.env ?? process.env,
    home: opts.home ?? os.homedir(),
    platform: opts.platform ?? process.platform,
  };
}

function macosDirs(name: string, home: string): AppDirs {
  const library = path.join(home, "Library");
  return {
    data: path.join(library, "Application Support", name),
    config: path.join(library, "Preferences", name),
    cache: path.join(library, "Caches", name),
    log: path.join(library, "Logs", name),
  };
}

function windowsDirs(name: string, { env, home }: Resolved): AppDirs {
  const roaming = env.APPDATA || path.join(home, "AppData", "Roaming");
  const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  return {
    data: path.join(local, name, "Data"),
    config: path.join(roaming, name, "Config"),
    cache: path.join(local, name, "Cache"),
    log: path.join(local, name, "Log"),
  };
}

// `||`, not `??`: like env-paths, an empty XDG variable falls back to the default.
function xdgDirs(name: string, { env, home }: Resolved): AppDirs {
  return {
    data: path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), name),
    config: path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), name),
    cache: path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), name),
    log: path.join(env.XDG_STATE_HOME || path.join(home, ".local", "state"), name),
  };
}

/** env-paths' data, config, cache and log table for `name`, without the `-nodejs` suffix. */
export function appDirs(name: string, opts: PathOptions = {}): AppDirs {
  const resolved = resolveOptions(opts);
  if (resolved.platform === "darwin") return macosDirs(name, resolved.home);
  if (resolved.platform === "win32") return windowsDirs(name, resolved);
  return xdgDirs(name, resolved);
}

function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

/** The app's data directory: the override variable when non-empty (`~` expanded, resolved), else `appDirs(name).data`. */
export function appDataRoot(app: AppSpec, opts: PathOptions = {}): string {
  const resolved = resolveOptions(opts);
  const override = resolved.env[app.overrideVar];
  if (override) return path.resolve(expandTilde(override, resolved.home));
  return appDirs(app.name, resolved).data;
}

/** active-work's data root, as its own CLI resolves it. */
export function activeWorkRoot(opts: PathOptions = {}): string {
  return appDataRoot(ACTIVE_WORK, opts);
}

/** active-work's session graph database: `<root>/.miner/graph.sqlite3`. */
export function activeWorkGraphPath(opts: PathOptions = {}): string {
  return path.join(activeWorkRoot(opts), ".miner", "graph.sqlite3");
}
