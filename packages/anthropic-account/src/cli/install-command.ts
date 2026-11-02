import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CliContext } from "./context.js";
import { EXIT_FAILED, EXIT_OK, PROGRAM } from "./report.js";

export const LAUNCHD_LABEL = "com.titan.anthropic-account-poll";
const TIMER = "anthropic-account-poll.timer";
const SYSTEMD_UNITS = ["anthropic-account-poll.service", TIMER, "anthropic-account-poll-failed@.service"];

interface InstallOptions {
  dryRun: boolean;
}

interface Step {
  file: string;
  args: string[];
  // A step that may fail without failing the command, such as booting out an agent that is not loaded.
  optional?: boolean;
}

interface Plan {
  files: { path: string; text: string }[];
  enable: Step[];
  disable: Step[];
}

// The package root holds systemd/ beside dist/ when published and beside src/ in the repo.
function shippedUnitDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1, dir = path.dirname(dir)) {
    const candidate = path.join(dir, "systemd");
    if (fs.existsSync(path.join(candidate, TIMER))) return candidate;
  }
  throw new Error("shipped systemd units not found");
}

// The poller on darwin never refreshes: it reads the login and leaves renewal to Claude Code.
export function launchdPlist(home: string): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${home}/.local/bin/anthropic-account</string>`,
    "    <string>poll</string>",
    "    <string>--write</string>",
    "  </array>",
    "  <key>StartInterval</key><integer>150</integer>",
    "  <key>RunAtLoad</key><true/>",
    `  <key>StandardErrorPath</key><string>${home}/Library/Logs/anthropic-account-poll.log</string>`,
    "</dict>",
    "</plist>",
    "",
  ];
  return lines.join("\n");
}

function systemdPlan(context: CliContext, home: string): Plan {
  const configHome = context.env.XDG_CONFIG_HOME || path.join(home, ".config");
  const source = context.templateDir ?? shippedUnitDir();
  const files = SYSTEMD_UNITS.map((name) => ({
    path: path.join(configHome, "systemd", "user", name),
    text: fs.readFileSync(path.join(source, name), "utf8"),
  }));
  return {
    files,
    enable: [
      { file: "systemctl", args: ["--user", "daemon-reload"] },
      { file: "systemctl", args: ["--user", "enable", "--now", TIMER] },
    ],
    disable: [
      { file: "systemctl", args: ["--user", "disable", "--now", TIMER] },
      { file: "systemctl", args: ["--user", "daemon-reload"] },
    ],
  };
}

function launchdPlan(context: CliContext, home: string): Plan {
  const plist = path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const domain = `gui/${context.uid ?? process.getuid?.() ?? 0}`;
  return {
    files: [{ path: plist, text: launchdPlist(home) }],
    enable: [
      { file: "launchctl", args: ["bootout", `${domain}/${LAUNCHD_LABEL}`], optional: true },
      { file: "launchctl", args: ["bootstrap", domain, plist] },
    ],
    disable: [{ file: "launchctl", args: ["bootout", `${domain}/${LAUNCHD_LABEL}`] }],
  };
}

function planFor(context: CliContext): Plan | undefined {
  const home = context.home ?? os.homedir();
  const platform = context.platform ?? process.platform;
  if (platform === "linux") return systemdPlan(context, home);
  if (platform === "darwin") return launchdPlan(context, home);
  return undefined;
}

function defaultExec(file: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], (error) => (error ? reject(error) : resolve()));
  });
}

async function runSteps(steps: Step[], context: CliContext): Promise<boolean> {
  const exec = context.exec ?? defaultExec;
  let ok = true;
  for (const step of steps) {
    try {
      await exec(step.file, step.args);
    } catch {
      if (!step.optional) ok = false;
    }
  }
  return ok;
}

const commandLine = (step: Step): string => `run: ${[step.file, ...step.args].join(" ")}`;

function printDryRun(plan: Plan, steps: Step[], verb: "write" | "remove", context: CliContext): void {
  for (const file of plan.files) {
    context.out(`${verb}: ${file.path}`);
    if (verb === "write") context.out(file.text);
  }
  for (const step of steps) context.out(commandLine(step));
}

export async function runInstall(options: InstallOptions, context: CliContext): Promise<number> {
  const plan = planFor(context);
  if (!plan) {
    context.err(`${PROGRAM}: install supports linux and darwin only`);
    return EXIT_FAILED;
  }
  if (options.dryRun) {
    printDryRun(plan, plan.enable, "write", context);
    return EXIT_OK;
  }
  for (const file of plan.files) {
    fs.mkdirSync(path.dirname(file.path), { recursive: true });
    fs.writeFileSync(file.path, file.text, { mode: 0o644 });
    context.out(`wrote ${file.path}`);
  }
  return (await runSteps(plan.enable, context)) ? EXIT_OK : EXIT_FAILED;
}

export async function runUninstall(options: InstallOptions, context: CliContext): Promise<number> {
  const plan = planFor(context);
  if (!plan) {
    context.err(`${PROGRAM}: uninstall supports linux and darwin only`);
    return EXIT_FAILED;
  }
  if (options.dryRun) {
    printDryRun(plan, plan.disable, "remove", context);
    return EXIT_OK;
  }
  const disabled = await runSteps(plan.disable.slice(0, 1), context);
  for (const file of plan.files) {
    fs.rmSync(file.path, { force: true });
    context.out(`removed ${file.path}`);
  }
  const reloaded = await runSteps(plan.disable.slice(1), context);
  return disabled && reloaded ? EXIT_OK : EXIT_FAILED;
}
