import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@titan-design/daemon";
import { BY_REC_POLICY_FILE } from "./by-rec-log.js";
import { startByRecRounds } from "./by-rec-timer.js";

let root: string;
let stateDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "by-rec-timer-"));
  stateDir = path.join(root, "state");
  await mkdir(path.join(root, "rounds"));
  await mkdir(stateDir);
  await writeFile(path.join(stateDir, BY_REC_POLICY_FILE), "not json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (_fields: Record<string, unknown>, message: string) => void lines.push(message);
  return { lines, info: push, warn: push, error: push };
}

const start = (logger: Logger, firstAfterMs: number) =>
  startByRecRounds({ dir: path.join(root, "rounds"), stateDir, submit: async () => ({ status: "already-submitted" }), logger, firstAfterMs, everyMs: 10 });

describe("the by-rec rounds timer", () => {
  it("sweeps after its first delay and keeps sweeping, logging a standing problem once", async () => {
    const logger = recordingLogger();
    const timer = start(logger, 10);

    await vi.waitFor(() => expect(logger.lines).toHaveLength(1));
    await sleep(100);
    timer.close();

    expect(logger.lines).toEqual([expect.stringContaining(BY_REC_POLICY_FILE)]);
  });

  it("never sweeps when closed before its first delay", async () => {
    const logger = recordingLogger();

    start(logger, 30).close();
    await sleep(120);

    expect(logger.lines).toEqual([]);
  });
});
