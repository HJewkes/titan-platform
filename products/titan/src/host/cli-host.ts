import { hostname } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { hostDoctor, type HostDoctorReport } from "./doctor.js";
import type { HostPorts } from "./ports.js";

interface HostIo {
  stdout: (text: string) => void;
  setExitCode: (code: number) => void;
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  ports: HostPorts;
}

export function registerHost(program: Command, io: HostIo): void {
  const host = program.command("host").description("Check and converge this host's coordination setup");
  registerDoctor(host, io);
}

function registerDoctor(host: Command, io: HostIo): void {
  host
    .command("doctor")
    .description("Run the product doctors and check every product and tool CLI is present at the expected version")
    .option("--json", "print the report as one JSON object")
    .action(async (opts: { json?: boolean }) => {
      const projectsRoot = io.env.TITAN_PROJECTS_ROOT ?? join(io.home, "projects");
      const report = await hostDoctor(io.ports, { host: hostname(), platform: io.platform, projectsRoot });
      io.stdout(opts.json ? `${JSON.stringify(report)}\n` : renderReport(report));
      io.setExitCode(report.ok ? 0 : 1);
    });
}

function renderReport(report: HostDoctorReport): string {
  const lines = report.rows.map((row) => `${row.status.padEnd(7)} ${row.id.padEnd(22)} ${row.detail}`);
  const failing = report.rows.filter((row) => row.status === "fail" || row.status === "missing").length;
  lines.push(failing === 0 ? "\nNothing failing on this host." : `\n${failing} rows failing.`);
  return `${lines.join("\n")}\n`;
}
