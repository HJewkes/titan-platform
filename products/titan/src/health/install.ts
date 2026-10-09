import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderSampleService, renderSampleTimer, SAMPLE_SERVICE, SAMPLE_TIMER, sampleUnitDir } from "./units.js";
import { stateHome, type HostEnv } from "./targets.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The machine-facing effects of install and uninstall; tests point systemctl at a stub. */
export interface InstallPorts extends HostEnv {
  platform: NodeJS.Platform;
  nodePath: string;
  titanBin: string;
  systemctl: (args: readonly string[]) => Promise<CommandResult>;
}

export interface InstallIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const FAILURE = 1;
/** Exit 2: this platform has no systemd user manager to install into. */
export const EXIT_UNSUPPORTED = 2;

const RELOAD = ["--user", "daemon-reload"];
const ENABLE = ["--user", "enable", "--now", SAMPLE_TIMER];
const DISABLE = ["--user", "disable", "--now", SAMPLE_TIMER];

function unsupported(verb: string, ports: InstallPorts, io: InstallIo): number | undefined {
  if (ports.platform === "linux") return undefined;
  io.stderr(`titan: health ${verb} is not supported on ${ports.platform}; see TP-1556\n`);
  return EXIT_UNSUPPORTED;
}

function fail(io: InstallIo, reason: string): number {
  io.stderr(`titan: ${reason}\n`);
  return FAILURE;
}

const detail = (result: CommandResult): string => result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;

/** Runs each command in order and stops at the first failure, returning its reason. */
async function runAll(ports: InstallPorts, commands: readonly string[][]): Promise<string | undefined> {
  for (const args of commands) {
    const result = await ports.systemctl(args);
    if (result.code !== 0) return `systemctl ${args.join(" ")} failed: ${detail(result)}`;
  }
  return undefined;
}

function renderedUnits(ports: InstallPorts): { dir: string; errLog: string; files: [string, string][] } {
  const dir = sampleUnitDir(ports);
  const errLog = join(stateHome(ports), "titan", "health-sample.err.log");
  const service = renderSampleService({ nodePath: ports.nodePath, titanBin: ports.titanBin, errLog });
  return { dir, errLog, files: [[join(dir, SAMPLE_SERVICE), service], [join(dir, SAMPLE_TIMER), renderSampleTimer()]] };
}

/** Rewriting identical files and re-enabling an enabled timer change nothing, so a rerun is safe. */
export async function installTimer(ports: InstallPorts, io: InstallIo, options: { dryRun: boolean }): Promise<number> {
  const refused = unsupported("install", ports, io);
  if (refused !== undefined) return refused;
  const { dir, errLog, files } = renderedUnits(ports);
  if (options.dryRun) {
    const shown = files.map(([path, text]) => `dry run: would write ${path}:\n${text}`).join("");
    io.stdout(`${shown}then run:\n${[RELOAD, ENABLE].map((args) => `  systemctl ${args.join(" ")}\n`).join("")}`);
    return 0;
  }
  mkdirSync(dirname(errLog), { recursive: true });
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of files) writeFileSync(path, text);
  const failure = await runAll(ports, [RELOAD, ENABLE]);
  if (failure !== undefined) return fail(io, failure);
  io.stdout(`installed ${SAMPLE_TIMER} from ${dir}\n`);
  return 0;
}

/** systemd still lists a unit whose file is gone until the next daemon-reload, so the reload comes last. */
export async function uninstallTimer(ports: InstallPorts, io: InstallIo): Promise<number> {
  const refused = unsupported("uninstall", ports, io);
  if (refused !== undefined) return refused;
  const { dir, files } = renderedUnits(ports);
  if (!files.some(([path]) => existsSync(path))) {
    io.stdout(`${SAMPLE_TIMER} is not installed in ${dir}\n`);
    return 0;
  }
  const disableFailure = await runAll(ports, [DISABLE]);
  if (disableFailure !== undefined) return fail(io, disableFailure);
  for (const [path] of files) rmSync(path, { force: true });
  const reloadFailure = await runAll(ports, [RELOAD]);
  if (reloadFailure !== undefined) return fail(io, reloadFailure);
  io.stdout(`uninstalled ${SAMPLE_TIMER}; removed its units from ${dir}\n`);
  return 0;
}
