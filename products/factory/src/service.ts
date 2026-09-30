import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SERVICE_LABEL = "dev.hjewkes.titan-factory";

export interface PlistOptions {
  /** Absolute path of the built `bin.js`. */
  binPath: string;
  /** Absolute path of the node binary launchd runs. */
  nodePath: string;
  logDir: string;
  port?: number;
  /** The job's whole PATH; see `servicePath`. */
  path: string;
}

/** What `titan-factory serve` runs by bare name: gh for every GitHub call, the other two for dispatch steps. */
export const SERVICE_BINARIES = ["gh", "agent-chat", "claude"] as const;
const LAUNCHD_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

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

/** launchd starts a job with its four system directories only. node's directory is there for `#!/usr/bin/env node` bins such as agent-chat. */
export function servicePath(which: (binary: string) => string | undefined, nodePath: string): ServicePath {
  const found = SERVICE_BINARIES.map((binary) => ({ binary, file: which(binary) }));
  const dirs = [...found.flatMap(({ file }) => (file === undefined ? [] : [pathEntry(file)])), pathEntry(nodePath), ...LAUNCHD_PATH];
  return { path: [...new Set(dirs)].join(":"), missing: found.filter(({ file }) => file === undefined).map(({ binary }) => binary) };
}

export function serviceLogDir(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "titan-factory");
}

export function plistPath(home: string): string {
  return join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
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

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** `Interactive`, not `Background`: macOS throttles a Background job's CPU and I/O, which starved the active-work daemon's index pass. */
export function renderPlist(options: PlistOptions): string {
  const argv = [options.nodePath, options.binPath, "serve", ...(options.port === undefined ? [] : ["--port", String(options.port)])];
  const strings = (values: readonly string[]): string => values.map((v) => `    <string>${escapeXml(v)}</string>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${SERVICE_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    strings(argv),
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Interactive</string>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>PATH</key>",
    `    <string>${escapeXml(options.path)}</string>`,
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(join(options.logDir, "serve.out.log"))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(join(options.logDir, "serve.err.log"))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}
