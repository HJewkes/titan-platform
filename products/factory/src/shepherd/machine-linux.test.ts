import { describe, expect, it } from "vitest";
import { readMachine } from "./spawn-gate.js";

const meminfo = (available: number) => `MemTotal:       16000000 kB\nMemFree:         500000 kB\nMemAvailable:   ${available} kB\nSwapTotal:       2000000 kB\nSwapFree:        2000000 kB\n`;
const psi = (avg60: string) => `some avg10=0.00 avg60=${avg60} avg300=0.10 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=45\n`;

function linux(files: Record<string, string>) {
  return readMachine({
    platform: "linux",
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    },
    sysctl: () => {
      throw new Error("sysctl is not read on linux");
    },
  });
}

describe("readMachine on linux", () => {
  it("reads free memory percent and pressure level 1 from a normal fixture", () => {
    const r = linux({ "/proc/meminfo": meminfo(8_000_000), "/proc/pressure/memory": psi("1.25") });
    expect(r).toMatchObject({ freeMemoryPct: 50, pressureLevel: 1 });
  });

  it("reads free memory under 20 percent when MemAvailable is low", () => {
    const r = linux({ "/proc/meminfo": meminfo(1_600_000), "/proc/pressure/memory": psi("0.00") });
    expect(r.freeMemoryPct).toBe(10);
  });

  it.each([
    ["9.99", 1],
    ["10.00", 2],
    ["39.99", 2],
    ["40.00", 4],
  ])("maps PSI avg60 %s to pressure level %i", (avg60, level) => {
    expect(linux({ "/proc/meminfo": meminfo(8_000_000), "/proc/pressure/memory": psi(avg60) }).pressureLevel).toBe(level);
  });

  it("leaves pressure absent when the PSI file is missing", () => {
    const r = linux({ "/proc/meminfo": meminfo(8_000_000) });
    expect(r.pressureLevel).toBeUndefined();
    expect(r.freeMemoryPct).toBe(50);
  });

  it("leaves free memory absent when the MemAvailable line is malformed", () => {
    const r = linux({ "/proc/meminfo": "MemTotal: 16000000 kB\nMemAvailable: lots\n", "/proc/pressure/memory": psi("1.00") });
    expect(r.freeMemoryPct).toBeUndefined();
    expect(r.pressureLevel).toBe(1);
  });
});

describe("readMachine off linux", () => {
  it("keeps the darwin sysctl readings", () => {
    const asked: string[] = [];
    const r = readMachine({
      platform: "darwin",
      readFile: () => {
        throw new Error("no /proc on darwin");
      },
      sysctl: (name) => {
        asked.push(name);
        return name.endsWith("level") && name.includes("pressure") ? 2 : 77;
      },
    });
    expect(asked).toEqual(["kern.memorystatus_vm_pressure_level", "kern.memorystatus_level"]);
    expect(r).toMatchObject({ pressureLevel: 2, freeMemoryPct: 77 });
  });

  it("reads memory as absent on other platforms", () => {
    const r = readMachine({ platform: "win32", sysctl: () => undefined });
    expect(r).toMatchObject({ pressureLevel: undefined, freeMemoryPct: undefined });
  });
});
