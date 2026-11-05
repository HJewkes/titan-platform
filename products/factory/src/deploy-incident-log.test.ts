import { describe, expect, it } from "vitest";
import type { DeployIncident } from "./deploy-incident.js";
import { deployIncidentLogPath, ensureDeployIncidentLog, readDeployIncidents, recordDeployIncident } from "./deploy-incident-log.js";

const STATE = "/xdg/state/titan-factory";
const LOG = deployIncidentLogPath(STATE);
const [OLD, NEW, NEWER] = ["1".repeat(40), "2".repeat(40), "3".repeat(40)];

const incident = (target: string, from: string, at: string): DeployIncident => ({ kind: "rolled-back", target, from, why: "health watch failed", at });

function memoryDisk(files: Record<string, string> = {}) {
  const disk = new Map(Object.entries(files));
  const ports = { exists: (path: string) => disk.has(path), readFile: (path: string) => disk.get(path), writeFile: (path: string, text: string) => void disk.set(path, text) };
  return { disk, ports, read: (path: string) => disk.get(path) };
}

describe("deploy incident log", () => {
  it("records two incidents and reads both back in order", () => {
    const { ports, read } = memoryDisk();
    const first = incident(NEW, OLD, "2026-10-01T00:00:00.000Z");
    const second = incident(NEWER, OLD, "2026-10-02T00:00:00.000Z");

    recordDeployIncident(ports, STATE, first);
    recordDeployIncident(ports, STATE, second);

    expect(readDeployIncidents(STATE, read)).toEqual([first, second]);
  });

  it("reads an absent log as undefined", () => {
    const { read } = memoryDisk();

    expect(readDeployIncidents(STATE, read)).toBeUndefined();
  });

  it("reads an empty log as no incidents", () => {
    const { read } = memoryDisk({ [LOG]: "" });

    expect(readDeployIncidents(STATE, read)).toEqual([]);
  });

  it("skips a torn last line", () => {
    const kept = incident(NEW, OLD, "2026-10-01T00:00:00.000Z");
    const { read } = memoryDisk({ [LOG]: `${JSON.stringify(kept)}\n{"kind":"rolled-back","tar` });

    expect(readDeployIncidents(STATE, read)).toEqual([kept]);
  });

  it("skips a malformed line between two good ones", () => {
    const [first, second] = [incident(NEW, OLD, "2026-10-01T00:00:00.000Z"), incident(NEWER, NEW, "2026-10-02T00:00:00.000Z")];
    const { read } = memoryDisk({ [LOG]: `${JSON.stringify(first)}\n{"kind":"rolled-back","target":42}\nnot json\n${JSON.stringify(second)}\n` });

    expect(readDeployIncidents(STATE, read)).toEqual([first, second]);
  });

  it("starts a new incident on its own line after a torn last line", () => {
    const next = incident(NEWER, NEW, "2026-10-02T00:00:00.000Z");
    const { ports, read } = memoryDisk({ [LOG]: '{"kind":"rolled-back","tar' });

    recordDeployIncident(ports, STATE, next);

    expect(readDeployIncidents(STATE, read)).toEqual([next]);
  });

  it("creates an empty log when absent and never truncates one that exists", () => {
    const kept = `${JSON.stringify(incident(NEW, OLD, "2026-10-01T00:00:00.000Z"))}\n`;
    const absent = memoryDisk();
    const present = memoryDisk({ [LOG]: kept });

    ensureDeployIncidentLog(absent.ports, STATE);
    ensureDeployIncidentLog(present.ports, STATE);

    expect(absent.disk.get(LOG)).toBe("");
    expect(present.disk.get(LOG)).toBe(kept);
  });

  it("reports a failed write instead of throwing", () => {
    const ports = { exists: () => false, readFile: () => undefined, writeFile: () => { throw new Error("read-only file system"); } };

    expect(recordDeployIncident(ports, STATE, incident(NEW, OLD, "2026-10-01T00:00:00.000Z"))).toBe("read-only file system");
    expect(ensureDeployIncidentLog(ports, STATE)).toBe("read-only file system");
  });
});
