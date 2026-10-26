import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { invokeCommand } from "@titan-design/registry";
import { configArgs, importRevisionZero } from "./cli.js";
import { compareTree, compareTreeResult, configStoreCommands, relativeReadError, type CompareTreeResult, type ConfigStoreSource } from "./compare.js";
import { readRevisionLog, revisionLogPath } from "./log.js";
import { FIXTURE_LIMITS, copyFixtureTree, tempDir } from "./test-tree.js";

const AT = new Date("2031-01-02T03:04:05.000Z");

function writtenLimits(stateDir: string): string {
  const limitsFile = path.join(stateDir, "limits.json");
  writeFileSync(limitsFile, JSON.stringify(FIXTURE_LIMITS));
  return limitsFile;
}

async function importedStore(): Promise<ConfigStoreSource & { autonomyTree: string }> {
  const stateDir = tempDir("state");
  const source = { stateDir, autonomyTree: copyFixtureTree(), coordinatorFile: path.join(tempDir("cfg"), "titan-coordinator", "coordinator.json") };
  await importRevisionZero(source, source.autonomyTree, writtenLimits(stateDir), AT);
  return source;
}

async function rpcCompare(source: ConfigStoreSource | undefined): Promise<CompareTreeResult> {
  const { envelope } = await invokeCommand(configStoreCommands(source)["config.compareTree"], {}, { warnings: [], format: "json" });
  if (!envelope.ok) throw new Error(envelope.error);
  return compareTreeResult.parse(envelope.data);
}

describe("the compare-tree diff", () => {
  it("is empty for the fixture tree right after its import, with the materialized file current", async () => {
    const source = await importedStore();

    const result = await rpcCompare(source);

    expect(result).toMatchObject({ state: "compared", head: { rev: 0 }, materialized: "current", limitsFrom: "given", changes: [] });
  });

  it("names the field a seat file changed after the import", async () => {
    const source = await importedStore();
    const seat = path.join(source.autonomyTree, "seat-a.md");
    writeFileSync(seat, readFileSync(seat, "utf8").replace('"implementers": 4', '"implementers": 6'));

    const result = await compareTree(source);

    expect(result.state === "compared" && result.changes).toEqual([{ path: "seats.seat-a.concurrency.implementers", kind: "changed", before: 4, after: 6 }]);
  });

  it("reports a materialized file edited out of band as stale", async () => {
    const source = await importedStore();
    writeFileSync(source.coordinatorFile, readFileSync(source.coordinatorFile, "utf8").replace('"implementers": 4', '"implementers": 9'));

    expect(await compareTree(source)).toMatchObject({ state: "compared", materialized: "stale", changes: [] });
  });

  it("is not-configured with no tree and no-revisions before the import", async () => {
    const stateDir = tempDir("state");

    const states = await Promise.all([rpcCompare(undefined), compareTree({ stateDir, autonomyTree: null, coordinatorFile: "/unused" }), compareTree({ stateDir, autonomyTree: copyFixtureTree(), coordinatorFile: "/unused" })]);

    expect(states.map((result) => result.state)).toEqual(["not-configured", "not-configured", "no-revisions"]);
  });
});

describe("compare-tree read errors reaching a LAN caller", () => {
  const asRoot = process.getuid?.() === 0;

  async function rpcError(source: ConfigStoreSource): Promise<string> {
    const { envelope } = await invokeCommand(configStoreCommands(source)["config.compareTree"], {}, { warnings: [], format: "json" });
    return envelope.ok ? `unexpectedly ok: ${JSON.stringify(envelope.data)}` : envelope.error;
  }

  it("names the revision log relative to the state dir when its directory is a file (ENOTDIR)", async () => {
    const stateDir = tempDir("state");
    writeFileSync(path.join(stateDir, "config"), "");

    const message = await rpcError({ stateDir, autonomyTree: copyFixtureTree(), coordinatorFile: "/unused" });

    expect(message).toBe(`cannot read ${path.join("config", "coordinator.revisions.jsonl")}: ENOTDIR`);
    expect(message).not.toContain(stateDir);
  });

  it.skipIf(asRoot)("names the revision log relative to the state dir when it cannot be read (EACCES)", async () => {
    const source = await importedStore();
    chmodSync(revisionLogPath(source.stateDir), 0o000);

    const message = await rpcError(source);

    expect(message).toBe(`cannot read ${path.join("config", "coordinator.revisions.jsonl")}: EACCES`);
    expect(message).not.toContain(source.stateDir);
  });

  it("names a charter that is a directory relative to the tree (EISDIR)", async () => {
    const source = await importedStore();
    rmSync(path.join(source.autonomyTree, "charter.md"));
    mkdirSync(path.join(source.autonomyTree, "charter.md"));

    const result = await rpcCompare(source);

    expect(result.state === "tree-invalid" && result.errors).toEqual([{ file: "charter.md", path: "", message: "the file is unreadable: EISDIR" }]);
    expect(JSON.stringify(result)).not.toContain(source.autonomyTree);
  });

  it.skipIf(asRoot)("names an unreadable seat file relative to the tree (EACCES)", async () => {
    const source = await importedStore();
    chmodSync(path.join(source.autonomyTree, "seat-a.md"), 0o000);

    const result = await rpcCompare(source);

    expect(result.state === "tree-invalid" && result.errors).toEqual([{ file: "seat-a.md", path: "", message: "the file is unreadable: EACCES" }]);
    expect(JSON.stringify(result)).not.toContain(source.autonomyTree);
  });

  it("passes an error that is not an fs error through unchanged", () => {
    const error = new Error("not an fs error");

    expect(relativeReadError("/root", error)).toBe(error);
  });
});

describe("config import", () => {
  it("writes rev 0 by the import class and refuses a second import", async () => {
    const source = await importedStore();

    const again = importRevisionZero(source, source.autonomyTree, null, AT);

    await expect(again).rejects.toThrow(/already has revisions/);
    const log = await readRevisionLog(revisionLogPath(source.stateDir));
    expect(log.state === "verified" && [log.revisions.length, log.head.by.class, log.head.at]).toEqual([1, "import", AT.toISOString()]);
  });

  it("writes rev 0 into a zero-byte revision log as one valid line (TP-3685)", async () => {
    const stateDir = tempDir("state");
    const logFile = revisionLogPath(stateDir);
    mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    writeFileSync(logFile, "", { mode: 0o600 });
    const source = { stateDir, autonomyTree: copyFixtureTree(), coordinatorFile: path.join(tempDir("cfg"), "titan-coordinator", "coordinator.json") };

    await importRevisionZero(source, source.autonomyTree, writtenLimits(stateDir), AT);

    const log = await readRevisionLog(logFile);
    expect(readFileSync(logFile, "utf8").split("\n")).toHaveLength(2);
    expect(log.state === "verified" && [log.revisions.length, log.head.rev, log.head.by.class]).toEqual([1, 0, "import"]);
  });

  it("parses only the import and compare-tree verbs", () => {
    const parsed = [["config", "import", "/t"], ["config", "import", "/t", "--limits", "/l.json"], ["config", "compare-tree"], ["config", "import"], ["config", "import", "--limits", "/l.json"], ["config", "set"]].map(configArgs);

    expect(parsed).toEqual([{ verb: "import", tree: "/t", limits: null }, { verb: "import", tree: "/t", limits: "/l.json" }, { verb: "compare-tree" }, null, null, null]);
  });
});
