import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_WORKFLOW_TABLE, readPriorRouter, readWorkflowTable, workflowTablePath } from "./node.js";

const TABLE_TEXT = fs.readFileSync(DEFAULT_WORKFLOW_TABLE, "utf8");

const dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-node-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeTable(root: string, text: string) {
  const file = workflowTablePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe("reading the table from the autonomy root", () => {
  it("is undefined with no file, and the linted table with one", () => {
    const root = tempDir();

    expect(readWorkflowTable(root)).toBeUndefined();

    writeTable(root, TABLE_TEXT);

    expect(readWorkflowTable(root)?.table?.version).toBe("shape-v1");
  });
});

describe("readPriorRouter", () => {
  it("reads nothing when off, so an invalid table yields no note", () => {
    const root = tempDir();
    writeTable(root, "version: nope\n");

    expect(readPriorRouter("off", root)).toEqual({});
  });

  it("notes the missing table in shadow mode", () => {
    const root = tempDir();

    expect(readPriorRouter("shadow", root)).toEqual({
      note: `prior routing shadow: no workflow table at ${workflowTablePath(root)}; routing as today`,
    });
  });

  it("notes the lint lines of a failing table", () => {
    const root = tempDir();
    writeTable(root, TABLE_TEXT.replace("standard: local-fix", "standard: nowhere"));

    const { router, note } = readPriorRouter("shadow", root);

    expect(router).toBeUndefined();
    expect(note).toMatch(/^prior routing shadow: workflow table: .*unknown class "nowhere".*; routing as today$/);
  });

  it("gives a router over a valid table", () => {
    const root = tempDir();
    writeTable(root, TABLE_TEXT);

    expect(readPriorRouter("on", root).router?.mode).toBe("on");
  });
});
