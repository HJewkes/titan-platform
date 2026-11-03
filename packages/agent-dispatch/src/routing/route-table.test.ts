import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_WORKFLOW_TABLE, readRouteTable } from "./node.js";

const TABLE_TEXT = fs.readFileSync(DEFAULT_WORKFLOW_TABLE, "utf8");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tableFile(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-table-"));
  dirs.push(dir);
  const file = path.join(dir, "shape-v1.yml");
  fs.writeFileSync(file, text);
  return file;
}

const pinMtime = (file: string, seconds: number) => fs.utimesSync(file, seconds, seconds);

describe("readRouteTable", () => {
  it("ids the table by version and the first eight hex of its sha256", () => {
    expect(readRouteTable(tableFile(TABLE_TEXT)).table?.id).toMatch(/^shape-v1@[0-9a-f]{8}$/);
  });

  it("reports a missing file as a problem", () => {
    expect(readRouteTable(path.join(os.tmpdir(), "no-such-dir", "shape-v1.yml")).problem).toMatch(
      /^no workflow table at /,
    );
  });

  it("reports the lint lines of a failing table", () => {
    const file = tableFile(TABLE_TEXT.replace("standard: local-fix", "standard: nowhere"));

    expect(readRouteTable(file).problem).toMatch(/^workflow table: .*unknown class "nowhere"/);
  });

  it("serves the cached read until the mtime moves", () => {
    const file = tableFile(TABLE_TEXT);
    pinMtime(file, 1_000_000);
    const first = readRouteTable(file);

    fs.writeFileSync(file, TABLE_TEXT.replace("version: shape-v1", "version: shape-v9"));
    pinMtime(file, 1_000_000);

    expect(readRouteTable(file)).toBe(first);

    pinMtime(file, 1_000_060);

    expect(readRouteTable(file).problem).toMatch(/version/);
  });
});
