import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

/** Launches `explainer <argv>` detached, its output appended to `logFile`; tests pass a fake. */
export type DetachedSpawn = (argv: readonly string[], logFile: string) => void;

export interface LaunchIo {
  /** True when a systemd user manager is reachable, so a transient unit can outlive the caller's cgroup. */
  systemdReachable: () => boolean;
  /** Runs a command to completion and returns its exit status. */
  run: (command: string, args: readonly string[]) => number | null;
  detach: DetachedSpawn;
  node: string;
  bin: string;
}

/** A unit name systemd accepts: ASCII letters, digits, `-`, `_` and `.` only. */
export const unitNameOf = (editId: string): string => `explainer-run-${editId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;

/** The `systemd-run` argv that starts the run as a transient user unit appending to `logFile`. */
function systemdRunArgv(unit: string, node: string, bin: string, argv: readonly string[], logFile: string): string[] {
  return ["--user", "--collect", "--quiet", "--unit", unit, `--property=StandardOutput=append:${logFile}`, `--property=StandardError=append:${logFile}`, "--", node, bin, ...argv];
}

// The socket check is the cheap reachability test; `--version` only proves the client is installed.
const systemdUserReachable = (): boolean => {
  const runtime = process.env.XDG_RUNTIME_DIR;
  return runtime !== undefined && existsSync(path.join(runtime, "systemd", "private")) && spawnSync("systemd-run", ["--version"], { stdio: "ignore" }).status === 0;
};

// The running bin is `explainer` itself, so the run is the same build that stored the edit.
const spawnDetached: DetachedSpawn = (argv, logFile) => {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    spawn(process.execPath, [process.argv[1]!, ...argv], { detached: true, stdio: ["ignore", fd, fd] }).unref();
  } finally {
    closeSync(fd);
  }
};

const realIo = (): LaunchIo => ({
  systemdReachable: systemdUserReachable,
  run: (command, args) => spawnSync(command, [...args], { stdio: "ignore" }).status,
  detach: spawnDetached,
  node: process.execPath,
  bin: process.argv[1]!,
});

/**
 * A transient systemd user unit when the user manager is reachable, so a restart of the caller's service (which kills
 * its whole cgroup) leaves the run alive; otherwise, or when systemd-run refuses, a detached child.
 */
export function editLauncher(editId: string, io: LaunchIo = realIo()): DetachedSpawn {
  return (argv, logFile) => {
    if (io.systemdReachable()) {
      mkdirSync(path.dirname(logFile), { recursive: true });
      if (io.run("systemd-run", systemdRunArgv(unitNameOf(editId), io.node, io.bin, argv, logFile)) === 0) return;
    }
    io.detach(argv, logFile);
  };
}
