import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { missedNoticeRows } from "./round-notice-gaps.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "console-notice-gaps-missing-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("missed round-notice rows before any round is filed", () => {
  it("reads no rows from a rounds dir that does not exist", async () => {
    expect(await missedNoticeRows(path.join(stateDir, "rounds"), Date.parse("2026-10-20T13:00:00.000Z"))).toEqual([]);
  });
});
