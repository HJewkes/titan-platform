import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcriptFiles } from "./transcripts.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "retrieval-eval-transcripts-"));
  vi.stubEnv("HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function writeTranscript(...segments: string[]): string {
  const file = path.join(...segments);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{"type":"user"}\n');
  return file;
}

describe("transcriptFiles", () => {
  it("finds a subagent transcript under the second CLAUDE_CONFIG_DIRS root", async () => {
    const first = path.join(home, "config-a");
    const second = path.join(home, "config-b");
    const parent = writeTranscript(first, "projects", "-repo", "parent-session.jsonl");
    const subagent = writeTranscript(second, "projects", "-repo", "parent-session", "subagents", "agent-a1.jsonl");

    const files = await transcriptFiles({ CLAUDE_CONFIG_DIRS: [first, second].join(path.delimiter) });

    expect(files).toEqual([parent, subagent].sort());
  });

  it("reads only the CLAUDE_CONFIG_DIRS roots when the variable is set", async () => {
    writeTranscript(home, ".claude", "projects", "-repo", "default-session.jsonl");
    const override = path.join(home, "config-only");
    const kept = writeTranscript(override, "projects", "-repo", "kept-session.jsonl");

    const files = await transcriptFiles({ CLAUDE_CONFIG_DIRS: override });

    expect(files).toEqual([kept]);
  });

  it("returns an empty list when no root has transcripts", async () => {
    await expect(transcriptFiles({})).resolves.toEqual([]);
  });
});
