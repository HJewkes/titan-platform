import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { daemonPaths, readPidFile } from "@titan-design/daemon";
import { appendSamples, openHealthStore, probeHttp, type HealthSample } from "@titan-design/health";
import { registerCost } from "./cli-cost.js";
import { registerUptime } from "./cli-uptime.js";
import { registerImport } from "./import-stopgap.js";
import { sampleTick } from "./sample-tick.js";
import { loadTargets, stateHome, type HealthTarget, type HostEnv } from "./targets.js";

interface HealthIo extends HostEnv {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  setExitCode: (code: number) => void;
}

/** Exit 2: the tick could not be stored, so this minute is missing from the record. */
const EXIT_STORE = 2;

export function registerHealth(program: Command, io: HealthIo): void {
  const health = program.command("health").description("Sample and report the health of this host's services");
  registerSample(health, io);
  registerUptime(health, io, () => defaultDbPath(io));
  registerCost(health, io, () => defaultDbPath(io));
  registerImport(health, io, () => defaultDbPath(io));
}

function defaultDbPath(host: HostEnv): string {
  return join(stateHome(host), "titan", "health.sqlite3");
}

function registerSample(health: Command, io: HealthIo): void {
  health
    .command("sample")
    .description("Probe every target once and store the results plus the sampler's own cost in one write")
    .option("--db <path>", "health store (default: $XDG_STATE_HOME/titan/health.sqlite3)")
    .action(async (opts: { db?: string }) => io.setExitCode(await runSample(opts.db ?? defaultDbPath(io), io)));
}

async function runSample(dbPath: string, io: HealthIo): Promise<number> {
  const targets = loadTargets({ ...io, readFile: (path) => readFileSync(path, "utf8"), warn: (line) => io.stderr(`${line}\n`) });
  let written: number;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = openHealthStore(dbPath);
    try {
      written = await sampleTick(targets, { probe, append: (rows) => appendSamples(db, rows) });
    } finally {
      db.close();
    }
  } catch (error) {
    io.stderr(`titan: could not store the health tick in ${dbPath}: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_STORE;
  }
  io.stdout(`stored ${written} rows in ${dbPath}\n`);
  return 0;
}

function probe(target: HealthTarget): Promise<HealthSample> {
  const { pidStateDir, ...probeTarget } = target;
  if (!pidStateDir) return probeHttp(probeTarget);
  const expectedPid = async () => (await readPidFile(daemonPaths(pidStateDir)))?.pid ?? null;
  return probeHttp(probeTarget, { expectedPid });
}
