import { homedir } from "node:os";
import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { registerConfig, type ReportPorts } from "./config/report.js";
import { registerHealth } from "./health/cli-health.js";
import { registerHost } from "./host/cli-host.js";
import { realHostPorts, type HostPorts } from "./host/ports.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** The titan bin's absolute path; `bin.ts` passes its own. */
  titanBin?: string;
  /** Process and file access for `titan host`; tests inject fakes. */
  hostPorts?: HostPorts;
  /** File access and the HTTP client for `titan config report`; tests inject fakes. */
  reportPorts?: ReportPorts;
  fetch?: typeof fetch;
}

const defaultIo: CliIo = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) };

const EXIT_USAGE = 64;
const EXIT_SOFTWARE = 70;

/** Builds the titan program and runs it once. Returns the exit code. */
export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  let exitCode = 0;
  const program = new Command().name("titan").description("The titan host CLI").exitOverride();
  program.configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
  const env = io.env ?? process.env;
  const shared = {
    stdout: io.stdout,
    env,
    home: io.home ?? homedir(),
    platform: io.platform ?? process.platform,
    setExitCode: (code: number) => (exitCode = code),
  };
  registerHealth(program, { ...shared, stderr: io.stderr, titanBin: io.titanBin ?? resolve(process.argv[1] ?? "titan") });
  registerHost(program, { ...shared, ports: io.hostPorts ?? realHostPorts(env) });
  registerConfig(program, { ...shared, stderr: io.stderr, reportPorts: io.reportPorts, fetch: io.fetch });
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) return err.code === "commander.helpDisplayed" ? 0 : EXIT_USAGE;
    io.stderr(`titan: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_SOFTWARE;
  }
  return exitCode;
}
