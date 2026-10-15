import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** systemd expands `%` specifiers in every value below, so a literal one is doubled. */
export const noSpecifiers = (value: string): string => value.replace(/%/g, "%%");

/** systemd splits on whitespace and reads C escapes inside double quotes. */
export function quoteIfNeeded(value: string): string {
  return /[\s"'\\]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

/** ExecStart also expands `$VAR`, so a literal `$` is doubled there. */
export const execArg = (value: string): string => quoteIfNeeded(noSpecifiers(value).replace(/\$/g, "$$$$"));

/** XDG says a relative XDG_CONFIG_HOME is invalid and must be ignored. */
export function userUnitDir(home: string, xdgConfigHome?: string): string {
  const config = xdgConfigHome && isAbsolute(xdgConfigHome) ? xdgConfigHome : join(home, ".config");
  return join(config, "systemd", "user");
}

export interface NodeProbe {
  exists: (path: string) => boolean;
  realpath: (path: string) => string;
}

const CELLAR_NODE = /^(.+)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/;
const fsProbe: NodeProbe = { exists: existsSync, realpath: realpathSync };

/** A Homebrew Cellar path names one version and breaks on `brew upgrade`; the prefix symlink follows the upgrade. */
export function stableNodePath(execPath: string, probe: NodeProbe = fsProbe): string {
  const match = CELLAR_NODE.exec(execPath);
  if (!match) return execPath;
  const [, prefix, formula] = match;
  const link = formula === "node" ? `${prefix}/bin/node` : `${prefix}/opt/${formula}/bin/node`;
  return probe.exists(link) && probe.realpath(link) === probe.realpath(execPath) ? link : execPath;
}

/** The four system directories launchd starts a job with. */
export const SYSTEM_PATH: readonly string[] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export interface ServicePath {
  path: string;
  /** The binaries `which` did not find; their directories are not on `path`. */
  missing: string[];
}

/** A ":" inside a directory name would split into entries nobody chose, one of them possibly relative. */
function pathEntry(file: string): string {
  const dir = dirname(file);
  if (dir.includes(":")) throw new Error(`${file} cannot go on the service PATH: its directory contains ":", which separates PATH entries`);
  return dir;
}

/** A supervisor starts a job with SYSTEM_PATH only. node's directory is there for `#!/usr/bin/env node` bins. */
export function servicePath(which: (binary: string) => string | undefined, nodePath: string, binaries: readonly string[]): ServicePath {
  const found = binaries.map((binary) => ({ binary, file: which(binary) }));
  const dirs = [...found.flatMap(({ file }) => (file === undefined ? [] : [pathEntry(file)])), pathEntry(nodePath), ...SYSTEM_PATH];
  return { path: [...new Set(dirs)].join(":"), missing: found.filter(({ file }) => file === undefined).map(({ binary }) => binary) };
}
