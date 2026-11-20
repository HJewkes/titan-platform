import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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

  it("reports a dangling pointer and an unindexed file without fact text", async () => {
    const dir = writeMemory(path.join(temp.home, ".claude"), "p4", {
      "MEMORY.md": "- [Gone](gone.md) — deleted\n- [Kept](kept.md) — here\n",
      "kept.md": fact("kept", "Kept fact", `Body. ${SENTINEL}`),
      "orphan.md": fact("orphan", "Orphan fact", "Nobody points here."),
    });

    const { envelope } = await invokeCommand(memoryScan, {}, context());

    expect(envelope).toMatchObject({
      data: {
        index: {
          checked: 2, dangling: 1, unindexed: 2, unloaded: 0,
          findings: expect.arrayContaining([
            { index: path.join(dir, "MEMORY.md"), dangling: [{ file: "gone.md", line: 1 }], unindexed: [path.join(dir, "orphan.md")], unloaded: [] },
          ]),
        },
      },
    });
    expect(JSON.stringify(envelope)).not.toContain(SENTINEL);
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

  it("passes --group-threshold through to grouping", async () => {
    const { envelope } = await invokeCommand(memoryReport, { groupThreshold: 0 }, context());

    expect(envelope).toMatchObject({ ok: true, data: { files: 3, groups: 1, singletons: 0, largestGroup: 2 } });
  });

  it("refuses --skills-root off the CLI", async () => {
    const { envelope, exitCode } = await invokeCommand(memoryReport, { skillsRoot: [temp.home] }, context());

    expect(envelope.ok).toBe(false);
    expect(exitCode).toBe(EXIT.DATAERR);
  });

  it("refuses --out off the CLI and creates no directory", async () => {
    const out = path.join(temp.home, "refused-out");

    const { envelope, exitCode } = await invokeCommand(memoryReport, { out }, context());

    expect(envelope.ok).toBe(false);
    expect(exitCode).toBe(EXIT.DATAERR);
    expect(existsSync(out)).toBe(false);
  });

  it("accepts --skills-root and --out on the CLI", async () => {
    const out = path.join(temp.home, "out");

    const { envelope } = await invokeCommand(memoryReport, { skillsRoot: [path.join(temp.home, "nowhere")], out }, context("cli"));

    expect(envelope).toMatchObject({ data: { dir: expect.stringContaining(out), skillsIndexed: 0 } });
  });

  it("lists and counts the sections of a global CLAUDE.md and never proposes deleting it", async () => {
    const claudeMd = path.join(temp.home, ".claude", "CLAUDE.md");
    writeFileSync(claudeMd, `## Voice\n\nKeep answers short. ${SENTINEL}\n\n## Commits\n\nUse imperative subjects.\n`);
    const old = new Date(Date.now() - 400 * 86_400_000);
    utimesSync(claudeMd, old, old);

    const { envelope } = await invokeCommand(memoryReport, {}, context());

    expect(envelope).toMatchObject({ ok: true, data: { files: 3, instructionSections: 2, groups: 4 } });
    expect(envelope).not.toMatchObject({ data: { byDestination: { delete: expect.anything() } } });
    expect(JSON.stringify(envelope)).not.toContain(SENTINEL);
    const reports = path.join(temp.home, "state", "memory-miner");
    const [reportId = ""] = readdirSync(reports);
    expect(readFileSync(path.join(reports, reportId, "report.md"), "utf8")).toContain("#### Voice (instruction section)");
  });

  it("reports zero instruction sections when no CLAUDE.md exists", async () => {
    const { envelope } = await invokeCommand(memoryReport, {}, context());

    expect(envelope).toMatchObject({ ok: true, data: { instructionSections: 0 } });
  });

  it("proposes delete for a project fact whose old mtime is its only date", async () => {
    const dir = writeMemory(path.join(temp.home, ".claude"), "p3", { "sprint.md": fact("sprint", "Quarterly zebra migration milestone", "Ship it.", "project") });
    const old = new Date(Date.now() - 400 * 86_400_000);
    utimesSync(path.join(dir, "sprint.md"), old, old);

    const { envelope } = await invokeCommand(memoryReport, {}, context());

    expect(envelope).toMatchObject({ ok: true, data: { byDestination: { delete: 1 } } });
  });
});
