import { execFile } from "node:child_process";
import type { Command } from "commander";
import { installTimer, uninstallTimer, type CommandResult, type InstallPorts } from "./install.js";
import { stableNodePath } from "./units.js";
import type { HostEnv } from "./targets.js";

export interface InstallCliIo extends HostEnv {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  setExitCode: (code: number) => void;
  platform: NodeJS.Platform;
  /** Absolute path of the titan bin this process runs; the service's ExecStart calls it. */
  titanBin: string;
}

/** systemctl is looked up on the CLI's own PATH, which is how tests reach a stub. */
function runSystemctl(env: NodeJS.ProcessEnv): (args: readonly string[]) => Promise<CommandResult> {
  return (args) =>
    new Promise((resolve) => {
      execFile("systemctl", args, { env }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 127;
        resolve({ code, stdout, stderr: stderr || (error?.message ?? "") });
      });
    });
}

function installPorts(io: InstallCliIo): InstallPorts {
  return {
    env: io.env,
    home: io.home,
    platform: io.platform,
    nodePath: stableNodePath(process.execPath),
    titanBin: io.titanBin,
    systemctl: runSystemctl(io.env),
  };
}

export function registerInstall(health: Command, io: InstallCliIo): void {
  health
    .command("install")
    .description("Write the titan-health-sample service and minutely timer for the systemd user manager and enable the timer")
    .option("--dry-run", "print both units and the systemctl commands; write and run nothing")
    .action(async (opts: { dryRun?: boolean }) => io.setExitCode(await installTimer(installPorts(io), io, { dryRun: opts.dryRun === true })));
  health
    .command("uninstall")
    .description("Disable the titan-health-sample timer and remove both units")
    .action(async () => io.setExitCode(await uninstallTimer(installPorts(io), io)));
}
