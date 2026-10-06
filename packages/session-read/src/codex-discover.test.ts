import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexSourceCollisionError, codexHome, codexSourceId, discoverCodexSources } from "./codex-discover.js";
import { CODEX_THREAD, CODEX_TREE, codexFixtureRecords, renderCodexRollout } from "./codex-fixture.js";

let home: string;
let locked: string[];
const asRoot = process.getuid?.() === 0;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "titan-codex-discovery-"));
  locked = [];
});
afterEach(() => {
  for (const lockedPath of locked) chmodSync(lockedPath, 0o700);
  rmSync(home, { recursive: true, force: true });
});

describe("discoverCodexSources", () => {
  it("discovers active and archived rollouts from session metadata", async () => {
    const active = writeRollout("sessions/2026/09/11/rollout-child.jsonl", codexFixtureRecords());
    const archivedRecords = codexFixtureRecords();
    archivedRecords[0] = metadata("archived-thread", "archived-thread", "legacy");
    const archived = writeRollout("archived_sessions/rollout-archived.jsonl", archivedRecords);
    writeRollout("sessions/2026/09/11/not-a-rollout.jsonl", [{ type: "event_msg", payload: { type: "task_started" } }]);

    const sources = await discoverCodexSources({ codexHome: home, namespace: "host-a" });

    expect(sources.map((source) => source.path).sort()).toEqual([active, archived].sort());
    expect(sources.find((source) => source.path === active)).toMatchObject({
      sourceId: codexSourceId("host-a", CODEX_THREAD, "rollout-child.jsonl"),
      formatVersion: "0.154.0-test",
      conversation: { harness: "codex", namespace: "host-a", nativeId: CODEX_THREAD },
      provenance: { kind: "codex-rollout", sessionTreeId: CODEX_TREE, historyMode: "paginated" },
    });
  });

  it("keeps a moved rollout source stable and prefers its active copy", async () => {
    const records = codexFixtureRecords();
    const active = writeRollout("sessions/2026/09/11/rollout-same.jsonl", records);
    writeRollout("archived_sessions/rollout-same.jsonl", records);

    const sources = await discoverCodexSources({ codexHome: home, namespace: "host-a" });

    expect(sources).toHaveLength(1);
    expect(sources[0]?.path).toBe(active);
  });

  it("rejects an empty namespace", async () => {
    await expect(discoverCodexSources({ codexHome: home, namespace: " " })).rejects.toThrow(/namespace/);
  });

  it("deduplicates exact moved copies and rejects divergent source collisions", async () => {
    const active = codexFixtureRecords();
    writeRollout("sessions/2026/09/11/rollout-child.jsonl", active);
    writeRollout("archived_sessions/rollout-child.jsonl", active);
    await expect(discoverCodexSources({ codexHome: home, namespace: "host-a" })).resolves.toHaveLength(1);

    const divergent = codexFixtureRecords();
    (divergent[2] as { payload: Record<string, unknown> }).payload.model = "different-model";
    writeRollout("archived_sessions/rollout-child.jsonl", divergent);
    await expect(discoverCodexSources({ codexHome: home, namespace: "host-a" })).rejects.toBeInstanceOf(CodexSourceCollisionError);
  });

  it("returns no sources when the Codex home has no session directories", async () => {
    await expect(discoverCodexSources({ codexHome: path.join(home, "absent"), namespace: "host-a" })).resolves.toEqual([]);
  });

  it("skips a file whose first line is not JSON", async () => {
    const filePath = path.join(home, "sessions", "rollout-garbled.jsonl");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "not json\n", "utf8");

    await expect(discoverCodexSources({ codexHome: home, namespace: "host-a" })).resolves.toEqual([]);
  });

  it.skipIf(asRoot)("rejects instead of returning no sources when a rollout directory is unreadable", async () => {
    writeRollout("sessions/2026/09/11/rollout-child.jsonl", codexFixtureRecords());
    lock(path.join(home, "sessions", "2026"));

    await expect(discoverCodexSources({ codexHome: home, namespace: "host-a" })).rejects.toMatchObject({ code: "EACCES" });
  });

  it.skipIf(asRoot)("rejects when a rollout file is unreadable", async () => {
    lock(writeRollout("sessions/2026/09/11/rollout-child.jsonl", codexFixtureRecords()));

    await expect(discoverCodexSources({ codexHome: home, namespace: "host-a" })).rejects.toMatchObject({ code: "EACCES" });
  });
});

describe("codexHome", () => {
  const original = process.env.CODEX_HOME;
  afterEach(() => {
    if (original === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = original;
  });

  it("discovers rollouts under CODEX_HOME when no home is passed", async () => {
    const active = writeRollout("sessions/2026/09/11/rollout-child.jsonl", codexFixtureRecords());
    process.env.CODEX_HOME = home;

    const sources = await discoverCodexSources({ namespace: "host-a" });

    expect(sources.map((source) => source.path)).toEqual([active]);
  });

  it("falls back to ~/.codex when CODEX_HOME is empty", () => {
    expect(codexHome({ CODEX_HOME: "" })).toBe(path.join(os.homedir(), ".codex"));
  });
});

function lock(target: string): void {
  chmodSync(target, 0o000);
  locked.push(target);
}

function writeRollout(relative: string, records: readonly Record<string, unknown>[]): string {
  const filePath = path.join(home, relative);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, renderCodexRollout(records), "utf8");
  return filePath;
}

function metadata(id: string, sessionId: string, historyMode: string): Record<string, unknown> {
  return {
    timestamp: "2026-09-11T10:00:00Z",
    type: "session_meta",
    payload: { id, session_id: sessionId, cli_version: "0.154.0-test", history_mode: historyMode },
    ordinal: 0,
  };
}
