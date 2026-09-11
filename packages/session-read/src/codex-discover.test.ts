import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexSourceCollisionError, codexSourceId, discoverCodexSources } from "./codex-discover.js";
import { CODEX_THREAD, CODEX_TREE, codexFixtureRecords, renderCodexRollout } from "./codex-fixture.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "titan-codex-discovery-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

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
});

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
