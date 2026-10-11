import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { EXIT, invokeCommand } from "@titan-design/registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../config.js";
import { createMinerContext, type MinerContext } from "../context.js";
import { fact, useTempHome, writeMemory, type TempHome } from "../memory/home.fixture.js";
import { memoryReport, memoryScan, type MemoryReportResult, type MemoryScanResult } from "./memory.js";

const SENTINEL = "zebra-sentinel-body-text";

let temp: TempHome;

function context(surface?: "cli"): MinerContext {
  const ctx = createMinerContext(resolveConfig({ stateDir: path.join(temp.home, "state") }, {}), { surface });
  vi.spyOn(ctx, "graph");
  vi.spyOn(ctx, "playbook");
  return ctx;
}

const run = <R>(cmd: Parameters<typeof invokeCommand<MinerContext>>[0], args: unknown, ctx: MinerContext) =>
  invokeCommand(cmd, args, ctx) as Promise<{ envelope: { ok: boolean; data?: R; error?: string }; exitCode: number }>;

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

    const { envelope } = await run<MemoryScanResult>(memoryScan, {}, ctx);

    expect(envelope.data).toMatchObject({ files: 3, indexes: 1, byAccount: { default: 2, work: 1 }, byType: { feedback: 1, user: 1 } });
    expect(envelope.data?.unparsed.map((u) => path.basename(u.path))).toEqual(["broken.md"]);
    expect(ctx.graph).not.toHaveBeenCalled();
    expect(ctx.playbook).not.toHaveBeenCalled();
  });
});

describe("memory report", () => {
  it("writes the report under the state dir and returns no fact text", async () => {
    const ctx = context();

    const { envelope } = await run<MemoryReportResult>(memoryReport, {}, ctx);

    expect(envelope.ok).toBe(true);
    expect(envelope.data?.dir.startsWith(path.join(temp.home, "state", "memory-miner"))).toBe(true);
    expect(envelope.data).toMatchObject({ files: 3, skillsIndexed: 1, groups: 2, singletons: 2, largestGroup: 1 });
    expect(envelope.data?.byDestination.skill).toBe(1);
    expect(JSON.stringify(envelope)).not.toContain(SENTINEL);
    expect(ctx.graph).not.toHaveBeenCalled();
  });

  it("refuses --skills-root off the CLI", async () => {
    const { envelope, exitCode } = await run<MemoryReportResult>(memoryReport, { skillsRoot: [temp.home] }, context());

    expect(envelope.ok).toBe(false);
    expect(exitCode).toBe(EXIT.DATAERR);
  });

  it("accepts --skills-root and --out on the CLI", async () => {
    const out = path.join(temp.home, "out");

    const { envelope } = await run<MemoryReportResult>(memoryReport, { skillsRoot: [path.join(temp.home, "nowhere")], out }, context("cli"));

    expect(envelope.data?.dir.startsWith(out)).toBe(true);
    expect(envelope.data?.skillsIndexed).toBe(0);
  });
});
