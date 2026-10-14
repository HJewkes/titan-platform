/** systemd expands `%` specifiers in every value below, so a literal one is doubled. */
declare const noSpecifiers: (value: string) => string;
/** systemd splits on whitespace and reads C escapes inside double quotes. */
declare function quoteIfNeeded(value: string): string;
/** ExecStart also expands `$VAR`, so a literal `$` is doubled there. */
declare const execArg: (value: string) => string;
/** XDG says a relative XDG_CONFIG_HOME is invalid and must be ignored. */
declare function userUnitDir(home: string, xdgConfigHome?: string): string;
interface NodeProbe {
    exists: (path: string) => boolean;
    realpath: (path: string) => string;
}
/** A Homebrew Cellar path names one version and breaks on `brew upgrade`; the prefix symlink follows the upgrade. */
declare function stableNodePath(execPath: string, probe?: NodeProbe): string;
/** The four system directories launchd starts a job with. */
declare const SYSTEM_PATH: readonly string[];
interface ServicePath {
    path: string;
    /** The binaries `which` did not find; their directories are not on `path`. */
    missing: string[];
}
/** A supervisor starts a job with SYSTEM_PATH only. node's directory is there for `#!/usr/bin/env node` bins. */
declare function servicePath(which: (binary: string) => string | undefined, nodePath: string, binaries: readonly string[]): ServicePath;

export { type NodeProbe, SYSTEM_PATH, type ServicePath, execArg, noSpecifiers, quoteIfNeeded, servicePath, stableNodePath, userUnitDir };
