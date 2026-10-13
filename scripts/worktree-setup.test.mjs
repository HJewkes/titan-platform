import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
// agent-chat skips a setup step whose timeout exceeds this (worktree-setup.ts MAX_SETUP_TIMEOUT_MS).
const AGENT_CHAT_MAX_TIMEOUT_MS = 1_800_000;

const declared = () =>
  JSON.parse(readFileSync(join(REPO, ".agent-chat", "worktree.json"), "utf8"))
    .setup;

describe("agent-chat worktree setup declaration", () => {
  it("installs from the tree's own lockfile so a re-created tree never borrows an ancestor's node_modules", () => {
    const { command } = declared();

    expect(Array.isArray(command)).toBe(true);
    expect(
      command.every((part) => typeof part === "string" && part !== "")
    ).toBe(true);
    expect(command[0]).toBe("pnpm");
    expect(command).toContain("install");
    expect(command).toContain("--frozen-lockfile");
  });

  it("declares a timeout agent-chat accepts instead of skipping the step", () => {
    const { timeoutMs } = declared();

    expect(Number.isInteger(timeoutMs)).toBe(true);
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(AGENT_CHAT_MAX_TIMEOUT_MS);
  });
});
