import { homedir } from "node:os";
import { join } from "node:path";

export const SERVICE_LABEL = "dev.hjewkes.titan-factory";

export interface PlistOptions {
  /** Absolute path of the built `bin.js`. */
  binPath: string;
  /** Absolute path of the node binary launchd runs. */
  nodePath: string;
  logDir: string;
  port?: number;
}

export function serviceLogDir(env: NodeJS.ProcessEnv): string {
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "titan-factory");
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
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(join(options.logDir, "serve.out.log"))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(join(options.logDir, "serve.err.log"))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}
