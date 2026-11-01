import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HostPorts } from "../ports.js";
import type { PlannedService } from "./catalog.js";

/** Writes one unit file, creating its directory. Injectable so tests never touch a real unit dir. */
export type UnitWriter = (path: string, text: string) => Promise<void>;

export const writeUnitFile: UnitWriter = async (path, text) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
};

type InstallResult = { ok: true } | { ok: false; step: string; detail: string };

/**
 * Legacy timer off first, so two backup timers are never enabled together. Any failing step
 * stops the run and names itself; later steps (including the enable) do not run.
 */
export async function installRendered(row: PlannedService, ports: HostPorts, write: UnitWriter): Promise<InstallResult> {
  const commands = (row.commands ?? []).map((command) => command.split(" "));
  const isDisable = (argv: string[]) => argv.includes("disable");
  for (const argv of commands.filter(isDisable)) {
    const failed = await runSystemctl(argv, ports);
    if (failed) return failed;
  }
  for (const unit of row.units ?? []) {
    try {
      await write(unit.path, unit.text);
    } catch (error) {
      return { ok: false, step: `write ${unit.path}`, detail: error instanceof Error ? error.message : String(error) };
    }
  }
  for (const argv of commands.filter((argv) => !isDisable(argv))) {
    const failed = await runSystemctl(argv, ports);
    if (failed) return failed;
  }
  return { ok: true };
}

async function runSystemctl(argv: string[], ports: HostPorts): Promise<InstallResult | null> {
  const [command, ...args] = argv;
  const step = argv.join(" ");
  try {
    const result = await ports.exec(command ?? "systemctl", args);
    return result.code === 0 ? null : { ok: false, step, detail: result.stderr.trim() || `exit ${result.code}` };
  } catch (error) {
    return { ok: false, step, detail: error instanceof Error ? error.message : String(error) };
  }
}
