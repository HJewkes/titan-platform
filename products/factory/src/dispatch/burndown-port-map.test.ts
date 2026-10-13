import { describe, expect, it } from "vitest";
import map from "./burndown-port-map.json" with { type: "json" };

type Entry = { file: string; dest: string; portSlice?: string; reason?: string; imports: string[] };
const files: Entry[] = map.files;
const count = (pick: (f: Entry) => boolean) => files.filter(pick).length;

describe("burndown port map", () => {
  it("holds one entry per file in agent-chat's burndown directory", () => {
    expect(files).toHaveLength(map.fileCount);
    expect(map.fileCount).toBe(100);
    expect(new Set(files.map((f) => f.file)).size).toBe(files.length);
  });

  it("sends every file to a known destination", () => {
    const unknown = files.filter((f) => !Object.hasOwn(map.destinations, f.dest)).map((f) => `${f.file}: ${f.dest}`);

    expect(unknown).toEqual([]);
  });

  it("names the F slice that ports each seats-imported file if CC-1211 decides to port it", () => {
    const missing = files.filter((f) => f.dest === "G-2" && !["F2", "F3", "F4"].includes(f.portSlice ?? "")).map((f) => f.file);

    expect(missing).toEqual([]);
  });

  it("gives a reason for every dropped file", () => {
    expect(files.filter((f) => f.dest === "DROP" && !f.reason?.trim()).map((f) => f.file)).toEqual([]);
  });

  // These counts are copied into the done-whens of TP-2580, TP-2581 and TP-2582; a remap updates both.
  it("keeps the per-destination counts the F-slice done-whens carry", () => {
    const byDest = Object.fromEntries(Object.keys(map.destinations).map((d) => [d, count((f) => f.dest === d)]));

    expect(byDest).toEqual({ L1: 3, F1: 1, F2: 19, F3: 28, F4: 28, "G-1": 1, "G-2": 17, "G-4": 1, "G-10": 2, DROP: 0 });
    expect(count((f) => f.dest === "G-2" && f.portSlice === "F3")).toBe(14);
    expect(count((f) => f.dest === "G-2" && f.portSlice === "F4")).toBe(3);
  });

  it("resolves every internal import to another entry", () => {
    const names = new Set(files.map((f) => f.file));
    const dangling = files.flatMap((f) => f.imports.filter((i) => !names.has(i)).map((i) => `${f.file} -> ${i}`));

    expect(dangling).toEqual([]);
  });
});
