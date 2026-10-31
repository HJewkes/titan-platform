import { join } from "node:path";
import { execArg, noSpecifiers, quoteIfNeeded, servicePath as daemonServicePath, userUnitDir, type ServicePath } from "@titan-design/daemon/service";

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
  /** The directory the job starts in: the deploy checkout, so serve never runs from a tree an agent uses. */
  workingDirectory?: string;
}

/** What `titan-factory serve` runs by bare name: gh for every GitHub call, the other two for dispatch steps. */
export const SERVICE_BINARIES = ["gh", "agent-chat", "claude"] as const;

/** launchd starts a job with its four system directories only. node's directory is there for `#!/usr/bin/env node` bins such as agent-chat. */
export function servicePath(which: (binary: string) => string | undefined, nodePath: string): ServicePath {
  return daemonServicePath(which, nodePath, SERVICE_BINARIES);
}

export function plistPath(home: string, labelPrefix?: string): string {
  return join(home, "Library", "LaunchAgents", `${serviceLabel(labelPrefix)}.plist`);
}

export function unitPath(home: string, xdgConfigHome?: string): string {
  return join(userUnitDir(home, xdgConfigHome), UNIT_NAME);
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
    ...(options.workingDirectory === undefined ? [] : ["  <key>WorkingDirectory</key>", `  <string>${escapeXml(options.workingDirectory)}</string>`]),
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    "  <integer>60</integer>",
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

/**
 * The systemd --user twin of renderPlist: Restart=on-failure is KeepAlive SuccessfulExit=false, enabling under default.target is RunAtLoad.
 * A user manager starts jobs with its own minimal PATH, so the unit sets the same PATH the plist does.
 * `append:` takes the rest of the line as the path, so a log path is never quoted.
 * TimeoutStopSec sits above the restart fence's 45 s, so a hand `systemctl restart` of a wedged serve waits 60 s, not systemd's 90 s.
 * LimitCORE=0 because serve holds the bot token in memory and Node cannot clear its own dumpable flag (TP-3094 §5).
 */
export function renderUnit(options: PlistOptions): string {
  return [
    "[Unit]",
    "Description=titan-factory serve",
    "",
    "[Service]",
    "Type=simple",
    ...(options.workingDirectory === undefined ? [] : [`WorkingDirectory=${noSpecifiers(options.workingDirectory)}`]),
    `ExecStart=${serveArgv(options).map(execArg).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    "TimeoutStopSec=60",
    "LimitCORE=0",
    `Environment=${quoteIfNeeded(noSpecifiers(`PATH=${options.path}`))}`,
    `StandardOutput=append:${noSpecifiers(join(options.logDir, "serve.out.log"))}`,
    `StandardError=append:${noSpecifiers(join(options.logDir, "serve.err.log"))}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}
