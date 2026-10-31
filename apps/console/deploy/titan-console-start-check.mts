// The ExecStartPre of titan-console.service (TP-4638). Node exits 0 on an empty cli.js, so a release that a power loss
// left as files of 0 bytes restart-looped with nothing in the journal. Before each start this checks the build
// `current` names; when it is not whole, it points `current` at the newest whole release, or exits 1 saying why.
// The owner copies it outside every release (apps/console/docs/self-update.md), since a broken release's own copy is empty.
// Node runs it as is (type stripping), so it imports only node builtins and uses only erasable syntax.
import { lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Every effect the check has; tests pass fakes. */
export interface StartPorts {
  /** The directory the symlink `link` resolves to; undefined when it is missing or not a symlink. */
  readLink: (link: string) => string | undefined;
  /** Points `link` at `target` by renaming a fresh symlink over it, so a reader never sees it absent. */
  swapLink: (link: string, target: string) => void;
  listDirs: (dir: string) => string[];
  /** Bytes in `file`; undefined when it is missing. */
  fileSize: (file: string) => number | undefined;
  readFile: (file: string) => string | undefined;
  log: (line: string) => void;
}

export const EXIT = { OK: 0, NO_BUILD: 1 } as const;
const CLI = "apps/console/dist/cli.js";
const BUILD_INFO = "apps/console/dist/build-info.json";

interface Stamp {
  sha: string;
  builtAt: string;
}

function readStamp(text: string | undefined): Stamp | undefined {
  try {
    const parsed: unknown = JSON.parse(text ?? "");
    if (typeof parsed !== "object" || parsed === null || !("sha" in parsed) || !("builtAt" in parsed)) return undefined;
    return typeof parsed.sha === "string" && typeof parsed.builtAt === "string" ? { sha: parsed.sha, builtAt: parsed.builtAt } : undefined;
  } catch {
    return undefined;
  }
}

/** Why `dir` cannot start, or its stamp when its bin has bytes and its build-info parses. */
export function inspectBuild(ports: StartPorts, dir: string): Stamp | string {
  const size = ports.fileSize(path.join(dir, CLI));
  if (size === undefined || size === 0) return `${CLI} is ${size === undefined ? "missing" : "empty"}`;
  return readStamp(ports.readFile(path.join(dir, BUILD_INFO))) ?? `${BUILD_INFO} is unreadable`;
}

/** The newest release, by its stamp, whose bin has bytes and whose stamp names its own directory. */
function newestWhole(ports: StartPorts, root: string, broken: string): { dir: string; stamp: Stamp } | undefined {
  const releases = path.join(root, "releases");
  const whole = ports
    .listDirs(releases)
    .map((name) => ({ name, dir: path.join(releases, name) }))
    .filter(({ dir }) => dir !== broken)
    .map(({ name, dir }) => ({ name, dir, stamp: inspectBuild(ports, dir) }))
    .flatMap(({ name, dir, stamp }) => (typeof stamp !== "string" && stamp.sha === name ? [{ dir, stamp }] : []));
  return whole.sort((a, b) => b.stamp.builtAt.localeCompare(a.stamp.builtAt))[0];
}

export function checkCurrent(ports: StartPorts, root: string): number {
  const link = path.join(root, "current");
  const serving = ports.readLink(link);
  if (serving === undefined) {
    ports.log(`error: ${link} is not a symlink to a build; not starting the console`);
    return EXIT.NO_BUILD;
  }
  const inspected = inspectBuild(ports, serving);
  if (typeof inspected !== "string") return EXIT.OK;
  ports.log(`error: ${serving} cannot start: ${inspected}`);
  const fallback = newestWhole(ports, root, serving);
  if (fallback === undefined) {
    ports.log(`error: no whole release under ${path.join(root, "releases")}; not starting the console`);
    return EXIT.NO_BUILD;
  }
  ports.swapLink(link, fallback.dir);
  ports.log(`pointed ${link} at ${fallback.dir}, built ${fallback.stamp.builtAt}; ${serving} stays on disk to inspect`);
  return EXIT.OK;
}

function readLink(link: string): string | undefined {
  try {
    return lstatSync(link).isSymbolicLink() ? realpathSync(link) : undefined;
  } catch {
    return undefined;
  }
}

function swapLink(link: string, target: string): void {
  const fresh = `${link}.${process.pid}.new`;
  rmSync(fresh, { force: true });
  symlinkSync(target, fresh);
  renameSync(fresh, link);
}

function fileSize(file: string): number | undefined {
  try {
    return statSync(file).size;
  } catch {
    return undefined;
  }
}

function readFile(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

const nodePorts = (): StartPorts => ({ readLink, swapLink, listDirs, fileSize, readFile, log: (line) => console.error(line) });

/** The same default and override the bootstrap and the updater read. */
export function rootFrom(env: NodeJS.ProcessEnv): string {
  const root = env.TITAN_CONSOLE_UPDATE_ROOT || "~/.local/share/titan-console";
  return root.startsWith("~/") ? path.join(homedir(), root.slice(2)) : root;
}

/** Node resolves symlinks for the main module but not argv[1], so a symlinked home would never match a plain comparison. */
function launchedDirectly(argv1: string | undefined): boolean {
  try {
    return argv1 !== undefined && realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (launchedDirectly(process.argv[1])) process.exitCode = checkCurrent(nodePorts(), rootFrom(process.env));
