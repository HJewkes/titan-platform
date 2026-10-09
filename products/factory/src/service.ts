import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const DEFAULT_LABEL_PREFIX = "dev.hjewkes.";
const SERVICE_NAME = "titan-factory";

/** The label for `service.labelPrefix` from the factory config. Changing the prefix after an install leaves the old job loaded under its old label; uninstall first. */
export function serviceLabel(prefix: string = DEFAULT_LABEL_PREFIX): string {
  return `${prefix}${SERVICE_NAME}`;
}

export const SERVICE_LABEL = serviceLabel();
/** The launchd label without its owner prefix, the rule active-work's `active-work.service` follows too. */
export const UNIT_NAME = `${SERVICE_NAME}.service`;

export interface PlistOptions {
  /** Absolute path of the built `bin.js`. */
  binPath: string;
  /** Absolute path of the node binary launchd runs. */
  nodePath: string;
  logDir: string;
  /** `service.labelPrefix` from the factory config; unset keeps the default label. */
  labelPrefix?: string;
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

export function plistPath(home: string, labelPrefix?: string): string {
  return join(home, "Library", "LaunchAgents", `${serviceLabel(labelPrefix)}.plist`);
}

/** XDG says a relative XDG_CONFIG_HOME is invalid and must be ignored. */
export function unitPath(home: string, xdgConfigHome?: string): string {
  const config = xdgConfigHome && isAbsolute(xdgConfigHome) ? xdgConfigHome : join(home, ".config");
  return join(config, "systemd", "user", UNIT_NAME);
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

const serveArgv = (options: PlistOptions): string[] => [options.nodePath, options.binPath, "serve", ...(options.port === undefined ? [] : ["--port", String(options.port)])];

/** `Interactive`, not `Background`: macOS throttles a Background job's CPU and I/O, which starved the active-work daemon's index pass. */
export function renderPlist(options: PlistOptions): string {
  const argv = serveArgv(options);
  const strings = (values: readonly string[]): string => values.map((v) => `    <string>${escapeXml(v)}</string>`).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${serviceLabel(options.labelPrefix)}</string>`,
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

/** systemd expands `%` specifiers in every value below, so a literal one is doubled. */
const noSpecifiers = (value: string): string => value.replace(/%/g, "%%");

/** systemd splits on whitespace and reads C escapes inside double quotes. */
function quoteIfNeeded(value: string): string {
  return /[\s"'\\]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

/** ExecStart also expands `$VAR`, so a literal `$` is doubled there. */
const execArg = (value: string): string => quoteIfNeeded(noSpecifiers(value).replace(/\$/g, "$$$$"));

/**
 * The systemd --user twin of renderPlist: Restart=always is KeepAlive, enabling under default.target is RunAtLoad.
 * A user manager starts jobs with its own minimal PATH, so the unit sets the same PATH the plist does.
 * `append:` takes the rest of the line as the path, so a log path is never quoted.
 */
export function renderUnit(options: PlistOptions): string {
  return [
    "[Unit]",
    "Description=titan-factory serve",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${serveArgv(options).map(execArg).join(" ")}`,
    "Restart=always",
    "RestartSec=5",
    `Environment=${quoteIfNeeded(noSpecifiers(`PATH=${options.path}`))}`,
    `StandardOutput=append:${noSpecifiers(join(options.logDir, "serve.out.log"))}`,
    `StandardError=append:${noSpecifiers(join(options.logDir, "serve.err.log"))}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}
