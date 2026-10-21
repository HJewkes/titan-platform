import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { revisionSha, type CoordinatorConfig } from "@titan-design/coordinator";
import { importTree } from "./import.js";
import { appendRevision, readRevisionLog, revisionLogPath, RevisionLogError } from "./log.js";
import { FIXTURE_LIMITS, FIXTURE_TREE, tempDir } from "./test-tree.js";

let document: CoordinatorConfig;
const by = { class: "owner-terminal" as const, id: "owner" };
const at = "2031-01-02T03:04:05.000Z";

beforeAll(async () => {
  const imported = await importTree(FIXTURE_TREE, { limits: FIXTURE_LIMITS });
  if (!imported.ok) throw new Error("the fixture tree did not import");
  document = imported.document;
});

function raised(implementers: number): CoordinatorConfig {
  const copy = structuredClone(document);
  copy.seats["seat-a"]!.concurrency.implementers = implementers;
  return copy;
}

describe("the revision log", () => {
  it("lives under the console state dir's config/", () => {
    expect(revisionLogPath("/state")).toBe(path.join("/state", "config", "coordinator.revisions.jsonl"));
  });

  it("reads an absent log as empty", async () => {
    expect(await readRevisionLog(revisionLogPath(tempDir("log")))).toEqual({ state: "empty" });
  });

  it("numbers each appended revision and parents it on the previous one's sha", async () => {
    const file = revisionLogPath(tempDir("log"));

    const zero = await appendRevision(file, { at, by: { class: "import", id: "import" }, document });
    const one = await appendRevision(file, { at, by, document: raised(5) });
    const log = await readRevisionLog(file);

    expect([zero.rev, zero.parent, one.rev, one.parent]).toEqual([0, null, 1, revisionSha(zero)]);
    expect(log.state === "verified" && log.head.document.seats["seat-a"]?.concurrency.implementers).toBe(5);
  });

  it("creates the log 0600 in a 0700 config dir", async () => {
    const file = revisionLogPath(tempDir("log"));

    await appendRevision(file, { at, by, document });

    expect([statSync(file).mode & 0o777, statSync(path.dirname(file)).mode & 0o777]).toEqual([0o600, 0o700]);
  });

  it("reads a torn last line as invalid and appends nothing after it", async () => {
    const file = revisionLogPath(tempDir("log"));
    await appendRevision(file, { at, by, document });
    appendFileSync(file, '{"$schema":"titan-coord');
    const before = readFileSync(file, "utf8");

    const log = await readRevisionLog(file);
    const append = appendRevision(file, { at, by, document: raised(5) });

    expect(log).toMatchObject({ state: "invalid", errors: [{ rev: 1, message: "the last line is incomplete" }] });
    await expect(append).rejects.toThrow(RevisionLogError);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("reads a log whose earlier revision was edited in place as invalid", async () => {
    const file = revisionLogPath(tempDir("log"));
    await appendRevision(file, { at, by, document });
    await appendRevision(file, { at, by, document: raised(5) });
    writeFileSync(file, readFileSync(file, "utf8").replace('"implementers":4', '"implementers":9'));

    expect(await readRevisionLog(file)).toMatchObject({ state: "invalid", errors: [{ rev: 1, code: "parent" }] });
  });

  it("refuses a revision whose document fails the coordinator check and writes nothing", async () => {
    const file = revisionLogPath(tempDir("log"));
    const twoAttended = structuredClone(document);
    twoAttended.seats["seat-b"]!.attended = true;

    await expect(appendRevision(file, { at, by, document: twoAttended })).rejects.toThrow(/exactly one seat must be attended/);
    expect(await readRevisionLog(file)).toEqual({ state: "empty" });
  });
});
