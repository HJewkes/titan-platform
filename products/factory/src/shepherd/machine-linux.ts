import { readFileSync } from "node:fs";

export type ReadFile = (path: string) => string;

const readProcFile: ReadFile = (path) => readFileSync(path, "utf8");

const PROC_MEMINFO = "/proc/meminfo";
const PROC_PRESSURE_MEMORY = "/proc/pressure/memory";

/** Same thresholds as agent-chat's Linux machine guard (CC-805), so the two gates agree. */
const PSI_WARN_AVG60 = 10;
const PSI_CRITICAL_AVG60 = 40;

/** Darwin's kern.memorystatus_vm_pressure_level scale, so one limit covers both platforms. */
const PRESSURE_NORMAL = 1;
const PRESSURE_WARN = 2;
const PRESSURE_CRITICAL = 4;

interface LinuxMemoryReadings {
  pressureLevel?: number;
  freeMemoryPct?: number;
}

function meminfoKib(text: string, field: string): number | undefined {
  const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, "m").exec(text);
  return match === null ? undefined : Number(match[1]);
}

/** MemAvailable over MemTotal in whole percent rounded down; absent when either line is missing or implausible. */
function parseMeminfoFreePct(text: string): number | undefined {
  const total = meminfoKib(text, "MemTotal");
  const available = meminfoKib(text, "MemAvailable");
  if (total === undefined || available === undefined || total <= 0 || available > total) return undefined;
  return Math.floor((available / total) * 100);
}

/** Maps the `some avg60` of /proc/pressure/memory onto darwin's 1 normal, 2 warn, 4 critical; absent when unparsed. */
function parsePsiPressureLevel(text: string): number | undefined {
  const match = /^some avg10=[\d.]+ avg60=(\d+(?:\.\d+)?) /m.exec(text);
  const avg60 = match === null ? Number.NaN : Number(match[1]);
  if (!(avg60 >= 0 && avg60 <= 100)) return undefined;
  if (avg60 >= PSI_CRITICAL_AVG60) return PRESSURE_CRITICAL;
  return avg60 >= PSI_WARN_AVG60 ? PRESSURE_WARN : PRESSURE_NORMAL;
}

function readOrUndefined<T>(path: string, parse: (text: string) => T | undefined, readFile: ReadFile): T | undefined {
  try {
    return parse(readFile(path));
  } catch {
    return undefined;
  }
}

/** A missing or unreadable file leaves its reading absent, so the limit it feeds is not applied. */
export function readLinuxMemory(readFile: ReadFile = readProcFile): LinuxMemoryReadings {
  return {
    pressureLevel: readOrUndefined(PROC_PRESSURE_MEMORY, parsePsiPressureLevel, readFile),
    freeMemoryPct: readOrUndefined(PROC_MEMINFO, parseMeminfoFreePct, readFile),
  };
}
