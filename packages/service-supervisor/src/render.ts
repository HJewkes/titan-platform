import { execArg, noSpecifiers } from "@titan-design/daemon/service";

export type RestartPolicy = "always" | "on-failure" | "never";

/** launchd's ProcessType values; `Background` throttles CPU and I/O. */
export type LaunchdProcessType = "Standard" | "Background" | "Adaptive" | "Interactive";

export interface ServiceSpec {
  /** The launchd Label, reverse-DNS by convention. systemd names a unit by its file, so it ignores this. */
  label: string;
  description: string;
  /** The program and its arguments; the first entry must be an absolute path. */
  argv: readonly string[];
  /** Written in insertion order. */
  environment: Readonly<Record<string, string>>;
  stdoutPath: string;
  stderrPath: string;
  /** Defaults to "always". */
  restart?: RestartPolicy;
  /** Seconds systemd waits before a restart. Defaults to 5. */
  restartSec?: number;
  /** Omitted from the plist when unset. */
  launchdProcessType?: LaunchdProcessType;
}

function assertSingleLine(what: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${what} cannot contain a line break: a unit file is line-oriented`);
  return value;
}

/** `Environment="KEY=value"`: `\` and `"` are escaped for the quotes, `%` because it is a unit specifier. */
function systemdEnvironment(key: string, value: string): string {
  assertSingleLine(`environment ${key}`, value);
  const escaped = noSpecifiers(value.replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
  return `Environment="${key}=${escaped}"`;
}

const SYSTEMD_RESTART: Record<RestartPolicy, string> = { always: "always", "on-failure": "on-failure", never: "no" };

export function renderSystemdUserService(spec: ServiceSpec): string {
  const restart = SYSTEMD_RESTART[spec.restart ?? "always"];
  const execStart = spec.argv.map((arg) => execArg(assertSingleLine("argv entry", arg))).join(" ");
  return [
    "[Unit]",
    `Description=${noSpecifiers(assertSingleLine("description", spec.description))}`,
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    `Restart=${restart}`,
    `RestartSec=${spec.restartSec ?? 5}`,
    ...Object.entries(spec.environment).map(([key, value]) => systemdEnvironment(key, value)),
    `StandardOutput=append:${noSpecifiers(assertSingleLine("stdoutPath", spec.stdoutPath))}`,
    `StandardError=append:${noSpecifiers(assertSingleLine("stderrPath", spec.stderrPath))}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const str = (value: string, indent: string): string => `${indent}<string>${escapeXml(value)}</string>`;

function keepAlive(restart: RestartPolicy): string[] {
  if (restart === "on-failure") {
    return ["  <key>KeepAlive</key>", "  <dict>", "    <key>SuccessfulExit</key>", "    <false/>", "  </dict>"];
  }
  return ["  <key>KeepAlive</key>", restart === "always" ? "  <true/>" : "  <false/>"];
}

function environmentEntries(environment: Readonly<Record<string, string>>): string[] {
  return Object.entries(environment).flatMap(([key, value]) => [`    <key>${escapeXml(key)}</key>`, str(value, "    ")]);
}

export function renderLaunchAgentPlist(spec: ServiceSpec): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    str(spec.label, "  "),
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...spec.argv.map((arg) => str(arg, "    ")),
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    ...keepAlive(spec.restart ?? "always"),
    ...(spec.launchdProcessType ? ["  <key>ProcessType</key>", str(spec.launchdProcessType, "  ")] : []),
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...environmentEntries(spec.environment),
    "  </dict>",
    "  <key>StandardOutPath</key>",
    str(spec.stdoutPath, "  "),
    "  <key>StandardErrorPath</key>",
    str(spec.stderrPath, "  "),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}
