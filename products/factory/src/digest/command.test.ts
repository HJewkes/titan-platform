import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NOW, watchRow } from "../test-support/digest.js";
import { parseSince, runDigestVerb, type FactoryCall } from "./command.js";
import { AGENT_CHAT_FOLLOW_UPS } from "./collect.js";
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
  // No broker home and a dead active-work port, so the test never reads this machine's real owner queue.
  return { root, env: { XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), AGENT_CHAT_HOME: join(root, "agent-chat"), AW_PORT: "1" } };
}

const call: FactoryCall = async (name) =>
  name === "shepherd.list" ? { ok: true, data: [watchRow({ pr: 5, phase: "done", outcome: { kind: "merged", reason: null }, phaseSince: "2026-03-10T19:00:00Z" })] } : { ok: true, data: { gates: [] } };
const noAgentChat: Exec = async () => ({ code: 1, stdout: "", stderr: "error: broker not running" });

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
    expect(out.join("")).toContain("wrote ");
  });

  it("lists coordinators from the broker roster and pools from pace.json (TP-4626)", async () => {
    const { root, env } = workspace();
    mkdirSync(join(root, "agent-chat"));
    writeFileSync(join(root, "agent-chat/pace.json"), JSON.stringify({ at: 0, pools: { "pool-a": { sevenDay: 41, fiveHour: 9, stale: false } } }));
    const roster = [
      { name: "lead-coord", spawnedBy: "human", profile: "coordinator", presence: "live", spawnedAt: "2026-03-09T00:00:00Z" },
      { name: "worker-1", spawnedBy: "lead-coord", profile: "implementer", presence: "exited", spawnedAt: "2026-03-10T18:00:00Z" },
    ];
    const brokerOnly: Exec = async (bin, args, timeoutMs) => (args[0] === "agent" ? { code: 0, stdout: JSON.stringify(roster), stderr: "" } : noAgentChat(bin, args, timeoutMs));
    const merged = watchRow({ pr: 5, implementer: "worker-1", phase: "done", outcome: { kind: "merged", reason: null }, phaseSince: "2026-03-10T19:00:00Z" });
    const rows: FactoryCall = async (name, args) => (name === "shepherd.list" ? { ok: true, data: [merged] } : call(name, args));
    const { out, io } = capture(env);

    await runDigestVerb(io, rows, { dryRun: true }, { exec: brokerOnly, now: NOW });

    expect(out.join("")).toContain("## Seats (merged, spawned)\n- lead-coord: 1, 1");
    expect(out.join("")).toContain("- pool-a: week 41%, 5h 9%");
  });

  it("prints Shepherd's merges and the named agent-chat follow-ups, never running agent-chat digest (TP-4628)", async () => {
    const { env } = workspace();
    const calls: string[][] = [];
    const recording: Exec = async (bin, args, timeoutMs) => (calls.push([...args]), noAgentChat(bin, args, timeoutMs));
    const { out, io } = capture(env);

    await runDigestVerb(io, call, { dryRun: true }, { exec: recording, now: NOW });

    const markdown = out.join("");
    expect(markdown).toContain("## Merged (1)\n- acme/widgets#5: demo/T-1");
    for (const gap of AGENT_CHAT_FOLLOW_UPS) expect(markdown).toContain(`- ${gap.split(" ").slice(0, 6).join(" ")}`);
    expect(markdown).not.toContain("agent-chat digest");
    expect(calls.filter((args) => args[0] === "digest")).toEqual([]);
  });

  it("counts spawns by a retired generation of a coordinator in Seats (TP-4628)", async () => {
    const { env } = workspace();
    const live = [{ name: "lead-coord-2", spawnedBy: "human", profile: "coordinator", presence: "live", spawnedAt: "2026-03-10T17:00:00Z" }];
    const retired = [
      { name: "lead-coord", spawnedBy: "human", profile: "coordinator", presence: "detached", retired: true, spawnedAt: "2026-03-09T00:00:00Z", exitedAt: "2026-03-10T16:00:00Z" },
      { name: "worker-old", spawnedBy: "lead-coord", profile: "implementer", presence: "detached", retired: true, spawnedAt: "2026-03-10T15:00:00Z", exitedAt: "2026-03-10T16:30:00Z" },
    ];
    const broker: Exec = async (bin, args, timeoutMs) =>
      args[0] === "agent" ? { code: 0, stdout: JSON.stringify(args.includes("--include-retired") ? [...retired, ...live] : live), stderr: "" } : noAgentChat(bin, args, timeoutMs);
    const { out, io } = capture(env);

    await runDigestVerb(io, call, { dryRun: true }, { exec: broker, now: NOW });

    expect(out.join("")).toContain("- lead-coord: 0, 1");
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
