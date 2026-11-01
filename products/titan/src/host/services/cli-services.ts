import type { Command } from "commander";
import type { HostPorts } from "../ports.js";
import { planServices, type PlannedService, type ServicesPlan } from "./catalog.js";

export interface ServicesIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  setExitCode: (code: number) => void;
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  titanBin: string;
  ports: HostPorts;
}

/** Exit 2: installing stays the owner's job until adopting the legacy units has its own task. */
const EXIT_REFUSED = 2;

export function registerServices(host: Command, io: ServicesIo): void {
  const services = host.command("services").description("List the host-owned scheduled jobs and where each is installed from");
  const plan = () => planServices(io.platform, io.ports, { home: io.home, xdgConfigHome: io.env.XDG_CONFIG_HOME, titanBin: io.titanBin });
  services
    .command("list")
    .description("Print every host-owned job for this platform with its source")
    .option("--json", "print the plan as one JSON object")
    .action(async (opts: { json?: boolean }) => {
      const planned = await plan();
      io.stdout(opts.json ? `${JSON.stringify(planned)}\n` : renderList(planned));
    });
  services
    .command("install")
    .description("Print the units and commands that would install each job; writes nothing")
    .option("--dry-run", "print what would be written and run")
    .action(async (opts: { dryRun?: boolean }) => {
      if (!opts.dryRun) {
        io.stderr("titan: host services install only supports --dry-run; installing stays the owner's job\n");
        io.setExitCode(EXIT_REFUSED);
        return;
      }
      io.stdout(renderDryRun(await plan()));
    });
}

const source = (row: PlannedService): string => (row.task ? `${row.source} ${row.task}` : row.source);

function renderList(plan: ServicesPlan): string {
  if (plan.services.length === 0) return `No host-owned jobs are catalogued for ${plan.platform}.\n`;
  const lines = plan.services.map((row) => `${row.id.padEnd(16)} ${source(row).padEnd(16)} ${row.detail}`);
  return `${lines.join("\n")}\n`;
}

function renderDryRun(plan: ServicesPlan): string {
  if (plan.services.length === 0) return `No host-owned jobs are catalogued for ${plan.platform}.\n`;
  return plan.services.map(renderRowDryRun).join("\n");
}

function renderRowDryRun(row: PlannedService): string {
  const header = `${row.id}: ${source(row)}, ${row.detail}\n`;
  const units = (row.units ?? []).map((unit) => `dry run: would write ${unit.path}:\n${unit.text}`).join("");
  const legacy = (row.legacyFound ?? []).map((unit) => `replaces legacy unit ${unit}\n`).join("");
  const commands = row.commands?.length ? `then run:\n${row.commands.map((command) => `  ${command}\n`).join("")}` : "";
  return `${header}${units}${legacy}${commands}`;
}
