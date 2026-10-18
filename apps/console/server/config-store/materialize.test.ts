import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { documentSha, type CoordinatorConfig } from "@titan-design/coordinator";
import { importTree } from "./import.js";
import { coordinatorFilePath, materializeDocument, readMaterialized, type WriteBytes } from "./materialize.js";
import { FIXTURE_LIMITS, FIXTURE_TREE, tempDir } from "./test-tree.js";

let document: CoordinatorConfig;

beforeAll(async () => {
  const imported = await importTree(FIXTURE_TREE, { limits: FIXTURE_LIMITS });
  if (!imported.ok) throw new Error("the fixture tree did not import");
  document = imported.document;
});

/** Writes the first half of the bytes, then dies the way a killed process would mid-write. */
const crashMidWrite: WriteBytes = async (handle, bytes) => {
  await handle.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
  throw new Error("simulated crash mid-write");
};

describe("materializeDocument", () => {
  it("defaults to coordinator.json in titan-coordinator's app-paths config dir", () => {
    expect(coordinatorFilePath({ env: { XDG_CONFIG_HOME: "/xdg" }, home: "/home/user", platform: "linux" })).toBe("/xdg/titan-coordinator/coordinator.json");
  });

  it("writes a file whose document sha matches, 0600, with no temp file left beside it", async () => {
    const file = path.join(tempDir("doc"), "titan-coordinator", "coordinator.json");

    const { sha } = await materializeDocument(file, document);

    expect([sha, await readMaterialized(file, documentSha(document))]).toEqual([documentSha(document), "current"]);
    expect([statSync(file).mode & 0o777, readdirSync(path.dirname(file))]).toEqual([0o600, ["coordinator.json"]]);
  });

  it("leaves the previous document whole when the write crashes midway", async () => {
    const file = path.join(tempDir("doc"), "coordinator.json");
    await materializeDocument(file, document);
    const before = readFileSync(file, "utf8");
    const next = structuredClone(document);
    next.seats["seat-a"]!.concurrency.implementers = 5;

    const crash = materializeDocument(file, next, { writeBytes: crashMidWrite });

    await expect(crash).rejects.toThrow("simulated crash mid-write");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(path.dirname(file))).toEqual(["coordinator.json"]);
  });

  it("reads a hand-edited file as stale, an absent one as missing and a torn one as unreadable", async () => {
    const dir = tempDir("doc");
    const file = path.join(dir, "coordinator.json");
    await materializeDocument(file, document);
    writeFileSync(file, readFileSync(file, "utf8").replace('"implementers": 4', '"implementers": 9'));
    writeFileSync(path.join(dir, "torn.json"), '{"$schema": "titan-coord');

    const states = await Promise.all(["coordinator.json", "absent.json", "torn.json"].map((name) => readMaterialized(path.join(dir, name), documentSha(document))));

    expect(states).toEqual(["stale", "missing", "unreadable"]);
  });
});
