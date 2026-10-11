import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXIT, invokeCommand } from "@titan-design/registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../config.js";
import { createMinerContext, type MinerContext } from "../context.js";
import { fact, useTempHome, writeMemory, type TempHome } from "../memory/home.fixture.js";
import { memoryReport, memoryScan } from "./memory.js";

const SENTINEL = "zebra-sentinel-body-text";

let temp: TempHome;

function context(surface?: "cli"): MinerContext {
  const ctx = createMinerContext(resolveConfig({ stateDir: path.join(temp.home, "state") }, {}), { surface });
  vi.spyOn(ctx, "graph");
  vi.spyOn(ctx, "playbook");
  return ctx;
}


beforeEach(() => {
  temp = useTempHome();
  const claude = path.join(temp.home, ".claude");
  writeMemory(claude, "p1", {
    "MEMORY.md": "- [Release](release.md) — npm\n",
    "release.md": fact("release", "Pin npm in release jobs", `Pin npm to 11. ${SENTINEL}`),
    "broken.md": "---\nname: [unclosed\n---\nbody\n",
  });
  writeMemory(path.join(temp.home, ".claude-profiles", "work"), "p2", { "user.md": fact("user", "Owner prefers short answers", "Keep it short.", "user") });
  const skill = path.join(claude, "skills", "release-ops");
  mkdirSync(skill, { recursive: true });
  writeFileSync(path.join(skill, "SKILL.md"), "---\nname: release-ops\ndescription: Pin npm in release jobs and publish\n---\n");
});

afterEach(() => {
  vi.restoreAllMocks();
  temp.restore();
});

describe("memory scan", () => {
  it("counts facts by account and type, lists unparsed files, and never opens the graph", async () => {
    const ctx = context();

    const { envelope } = await invokeCommand(memoryScan, {}, ctx);

    expect(envelope).toMatchObject({ data: { files: 3, indexes: 1, byAccount: { default: 2, work: 1 }, byType: { feedback: 1, user: 1 } } });
    expect(envelope).toMatchObject({ data: { unparsed: [{ path: expect.stringMatching(/\/broken\.md$/) }] } });
    expect(ctx.graph).not.toHaveBeenCalled();
    expect(ctx.playbook).not.toHaveBeenCalled();
  });
});

describe("memory report", () => {
  it("writes the report under the state dir and returns no fact text", async () => {
    const ctx = context();

    const { envelope } = await invokeCommand(memoryReport, {}, ctx);

    expect(envelope).toMatchObject({
      ok: true,
      data: {
        dir: expect.stringContaining(path.join(temp.home, "state", "memory-miner")),
        files: 3, skillsIndexed: 1, groups: 2, singletons: 2, largestGroup: 1, byDestination: { skill: 1 },
      },
    });
    expect(JSON.stringify(envelope)).not.toContain(SENTINEL);
    expect(ctx.graph).not.toHaveBeenCalled();
  });

  it("refuses --skills-root off the CLI", async () => {
    const { envelope, exitCode } = await invokeCommand(memoryReport, { skillsRoot: [temp.home] }, context());

    expect(envelope.ok).toBe(false);
    expect(exitCode).toBe(EXIT.DATAERR);
  });

  it("accepts --skills-root and --out on the CLI", async () => {
    const out = path.join(temp.home, "out");

    const { envelope } = await invokeCommand(memoryReport, { skillsRoot: [path.join(temp.home, "nowhere")], out }, context("cli"));

    expect(envelope).toMatchObject({ data: { dir: expect.stringContaining(out), skillsIndexed: 0 } });
  });
});
