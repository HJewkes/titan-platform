import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NOW, watchRow } from "../test-support/digest.js";
import { parseSince, runDigestVerb, type FactoryCall } from "./command.js";
import type { Exec } from "./sources.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const SEAT = "---\nschema: autonomy-seat/v1\nname: seat-a\n---\n";
const QUEUE = "# Queue\n\n## Morning queue (owner only)\n\n1. Pick a badge colour.\n";

function workspace(): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "factory-digest-"));
  dirs.push(root);
  for (const dir of ["autonomy/seats", "autonomy/queues", "config/titan-factory"]) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, "autonomy/seats/seat-a.md"), SEAT);
  writeFileSync(join(root, "autonomy/queues/seat-a.md"), QUEUE);
  const config = { shepherd: { seatsDir: join(root, "autonomy/seats") }, digest: { outDir: join(root, "out"), icloudDir: join(root, "icloud") } };
  writeFileSync(join(root, "config/titan-factory/config.json"), JSON.stringify(config));
  return { root, env: { XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") } };
}

const call: FactoryCall = async (name) =>
  name === "shepherd.list" ? { ok: true, data: [watchRow({ pr: 5, phase: "done", phaseSince: "2026-03-10T19:00:00Z" })] } : { ok: true, data: { gates: [] } };
const noAgentChat: Exec = async () => ({ code: 1, stdout: "", stderr: "error: unknown option '--json'" });

function capture(env: NodeJS.ProcessEnv) {
  const out: string[] = [];
  return { out, io: { stdout: (t: string) => void out.push(t), stderr: (t: string) => void out.push(t), env } };
}

describe("runDigestVerb", () => {
  it("writes the slot's markdown to the digest dir and the iCloud dir", async () => {
    const { root, env } = workspace();
    const { out, io } = capture(env);

    const code = await runDigestVerb(io, call, {}, { exec: noAgentChat, now: NOW });

    const markdown = readFileSync(join(root, "out/2026-03-10-12.md"), "utf8");
    expect(code).toBe(0);
    expect(readFileSync(join(root, "icloud/2026-03-10-12.md"), "utf8")).toBe(markdown);
    expect(markdown).toContain("1. Pick a badge colour (seat-a)");
    expect(markdown).toContain("- acme/widgets#5: demo/T-1");
    expect(markdown).toContain("agent-chat digest: exit 1");
    expect(out.join("")).toContain("wrote ");
  });

  it("prints the digest and writes nothing on a dry run", async () => {
    const { root, env } = workspace();
    const { out, io } = capture(env);

    await runDigestVerb(io, call, { dryRun: true }, { exec: noAgentChat, now: NOW });

    expect(out.join("")).toMatch(/^# Owner digest 2026-03-10 12:00/);
    expect(existsSync(join(root, "out"))).toBe(false);
  });
});

describe("parseSince", () => {
  it("reads minutes, hours and days and refuses anything else", () => {
    expect([parseSince("90m"), parseSince("6h"), parseSince("2d")]).toEqual([90, 360, 2880]);
    expect(() => parseSince("6 hours")).toThrow(/--since/);
  });
});
