import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OCCUPANCY_FILE, occupancyPathFor, readOccupancy, writeOccupancy } from "./occupancy-file.js";
import { buildOccupancy, type OccupancyInput } from "./occupancy-table.js";

const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/anchors/marks.json", import.meta.url), "utf8")) as OccupancyInput;
const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "occupancy-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the occupancy file", () => {
  it("lives in the same directory as qa.json", () => {
    expect(occupancyPathFor("/render/out/qa.json")).toBe(`/render/out/${OCCUPANCY_FILE}`);
  });

  it("writes every mark's table beside qa.json and reads back the same tables", () => {
    const qa = join(scratch(), "out", "qa.json");
    const tables = buildOccupancy(FIXTURE);
    const path = writeOccupancy(qa, FIXTURE.stage, tables);
    expect(path).toBe(occupancyPathFor(qa));
    expect(readOccupancy(path)).toEqual({ schema: "occupancy/v1", stage: FIXTURE.stage, tables });
  });

  it("refuses a table with a cell off the grid and writes nothing", () => {
    const qa = join(scratch(), "qa.json");
    const bad = [{ mark: "b@1s", beat: "b", t: 1, source: "dom" as const, cells: { G7: ["x"] } }];
    expect(() => writeOccupancy(qa, FIXTURE.stage, bad as never)).toThrow(/A1 to F6/);
    expect(existsSync(occupancyPathFor(qa))).toBe(false);
  });

  it("rejects a file of another schema on read", () => {
    const path = join(scratch(), OCCUPANCY_FILE);
    writeFileSync(path, JSON.stringify({ schema: "occupancy/v0", stage: FIXTURE.stage, tables: [] }));
    expect(() => readOccupancy(path)).toThrow();
  });
});
