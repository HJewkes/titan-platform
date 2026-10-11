/** Where to read the environment from. Each field defaults to the current process. */
interface PathOptions {
    env?: Readonly<Record<string, string | undefined>>;
    home?: string;
    platform?: NodeJS.Platform;
}
/** The per-user directories env-paths gives an app with `{ suffix: "" }`. */
interface AppDirs {
    data: string;
    config: string;
    cache: string;
    log: string;
}
/** An app whose data root a non-empty environment variable may override. */
interface AppSpec {
    name: string;
    overrideVar: string;
}
declare const ACTIVE_WORK: AppSpec;
/** env-paths' data, config, cache and log table for `name`, without the `-nodejs` suffix. */
declare function appDirs(name: string, opts?: PathOptions): AppDirs;
/** The app's data directory: the override variable when non-empty (`~` expanded, resolved), else `appDirs(name).data`. */
declare function appDataRoot(app: AppSpec, opts?: PathOptions): string;
/** active-work's data root, as its own CLI resolves it. */
declare function activeWorkRoot(opts?: PathOptions): string;
/** active-work's session graph database: `<root>/.miner/graph.sqlite3`. */
declare function activeWorkGraphPath(opts?: PathOptions): string;

export { ACTIVE_WORK, type AppDirs, type AppSpec, type PathOptions, activeWorkGraphPath, activeWorkRoot, appDataRoot, appDirs };
