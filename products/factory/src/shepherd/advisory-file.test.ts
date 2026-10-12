import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { advisoryFile } from "./advisory-file.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-advisory-file-"));
  dirs.push(dir);
  return dir;
}

describe("advisoryFile", () => {
  it("loads in a fresh reader what an earlier one saved, creating a state dir that is not there yet", () => {
    const stateDir = join(tempDir(), "state", "titan-factory");

    advisoryFile(stateDir).save(["a/b"]);

    expect(advisoryFile(stateDir).load()).toEqual(["a/b"]);
  });

  it.each([
    ["is missing", undefined],
    ["is not JSON", "{ not json"],
    ["holds no repo list", JSON.stringify({ advisory: 3 })],
    ["holds null", "null"],
  ])("remembers nothing when the file %s", (_case, contents) => {
    const stateDir = tempDir();
    mkdirSync(stateDir, { recursive: true });
    if (contents !== undefined) writeFileSync(join(stateDir, "shepherd-advisory.json"), contents);

    expect(advisoryFile(stateDir).load()).toBeUndefined();
  });
});
