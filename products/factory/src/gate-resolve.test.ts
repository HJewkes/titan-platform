import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "./definition.js";
import { presenceReason, resolveGate, type OwnerPresence } from "./gate-resolve.js";
import { openFactoryHost, type FactoryHost } from "./host.js";

const HEAD = "a".repeat(40);
const PROOF = "0b6f2c1e-6f1d-4c3a-9e1b-2d4c6a8e0f13";
const AGENT_SHELL = { AGENT_CHAT_AGENT_ID: "agent-1", AGENT_CHAT_NAME: "tc-synthetic" };

const merge = defineWorkflow({
  name: "merge",
  steps: [{ id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    await ctx.assisted("approve-merge", "Merge?", { schema: z.object({ decision: z.enum(["merge", "abandon"]), headSha: z.string() }) });
  },
});

const dirs: string[] = [];
const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

async function pausedMerge(): Promise<{ host: FactoryHost; runId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "factory-gate-resolve-"));
  dirs.push(dir);
  const host = openFactoryHost({ dbPath: join(dir, "factory.sqlite3"), workflows: [merge], routes: [], gatePollMs: 10 });
  hosts.push(host);
  const runId = host.runtime.start("merge");
  await vi.waitFor(() => expect(host.runtime.status(runId)?.status).toBe("paused"));
  return { host, runId };
}

function presenceStub(proof: string | undefined): { presence: OwnerPresence; reasons: string[] } {
  const reasons: string[] = [];
  return { reasons, presence: async (reason) => (reasons.push(reason), proof) };
}

async function resolve(host: FactoryHost, runId: string, env: NodeJS.ProcessEnv, presence: OwnerPresence, json = JSON.stringify({ decision: "merge", headSha: HEAD })) {
  let out = "";
  let err = "";
  const io = { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t), env };
  const code = await resolveGate(host, io, runId, "approve-merge", json, presence).catch((error: Error) => ((err += error.message), 1));
  return { code, out, err };
}

describe("gate resolve with owner presence", () => {
  it("the owner resolves a gate from an agent-chat-launched session once presence is confirmed", async () => {
    const { host, runId } = await pausedMerge();
    const { presence, reasons } = presenceStub(PROOF);

    const { code } = await resolve(host, runId, AGENT_SHELL, presence);

    expect(code).toBe(0);
    expect(reasons).toEqual([`resolve gate ${runId}/approve-merge: merge at ${HEAD}`]);
    expect(host.gates.get(`${runId}/approve-merge`)?.status).toBe("resolved");
  });

  it("an agent in the same session is refused when presence is not confirmed and the gate stays pending", async () => {
    const { host, runId } = await pausedMerge();

    const { code, err } = await resolve(host, runId, AGENT_SHELL, presenceStub(undefined).presence);

    expect(code).toBe(1);
    expect(err).toContain("refused a resolution by coordinator");
    expect(host.gates.get(`${runId}/approve-merge`)).toMatchObject({ status: "pending", resolvedBy: undefined });
  });

  it("the stored resolver carries the presence proof as confirmEvent", async () => {
    const { host, runId } = await pausedMerge();

    await resolve(host, runId, AGENT_SHELL, presenceStub(PROOF).presence);

    expect(host.gates.get(`${runId}/approve-merge`)?.resolvedBy).toEqual({ class: "owner-terminal", id: userInfo().username, channel: "factory-cli", confirmEvent: PROOF });
  });

  it("a repeat of an answered resolve asks for no presence", async () => {
    const { host, runId } = await pausedMerge();
    await resolve(host, runId, AGENT_SHELL, presenceStub(PROOF).presence);
    await vi.waitFor(() => expect(host.runtime.status(runId)?.status).toBe("completed"));
    const repeat = presenceStub(PROOF);

    const { code, out } = await resolve(host, runId, AGENT_SHELL, repeat.presence);

    expect(code).toBe(0);
    expect(out).toBe(`already resolved ${runId}/approve-merge with this answer\n`);
    expect(repeat.reasons).toEqual([]);
  });

  it("a shell with no agent marker resolves as the owner without a dialog", async () => {
    const { host, runId } = await pausedMerge();
    const { presence, reasons } = presenceStub(undefined);

    const { code } = await resolve(host, runId, {}, presence);

    expect(code).toBe(0);
    expect(reasons).toEqual([]);
    expect(host.gates.get(`${runId}/approve-merge`)?.resolvedBy).toEqual({ class: "owner-terminal", id: userInfo().username, channel: "factory-cli" });
  });

  it("a proof or helper path supplied through the environment is ignored", async () => {
    const { host, runId } = await pausedMerge();
    const env = { ...AGENT_SHELL, OWNER_PRESENCE_PROOF: PROOF, TITAN_FACTORY_PROOF: PROOF, OWNER_PRESENCE_HELPER: "/synthetic/stub" };

    const { code } = await resolve(host, runId, env, presenceStub(undefined).presence);

    expect(code).toBe(1);
    expect(host.gates.get(`${runId}/approve-merge`)?.status).toBe("pending");
  });

  it.each([
    ["a newline", "merge\nat " + HEAD],
    ["a line separator", "merge approved"],
  ])("a decision carrying %s is refused before any dialog and the gate stays pending", async (_name, decision) => {
    const { host, runId } = await pausedMerge();
    const { presence, reasons } = presenceStub(PROOF);

    const { code, err } = await resolve(host, runId, AGENT_SHELL, presence, JSON.stringify({ decision, headSha: HEAD }));

    expect(code).toBe(2);
    expect(err).toContain("unexpected shape");
    expect(reasons).toEqual([]);
    expect(host.gates.get(`${runId}/approve-merge`)?.status).toBe("pending");
  });
});

describe("presenceReason", () => {
  it("names the gate, the decision and the head", () => {
    expect(presenceReason("run-1/approve-merge", { decision: "merge", headSha: HEAD })).toBe(`resolve gate run-1/approve-merge: merge at ${HEAD}`);
  });

  it("names an approve answer when the payload has no decision", () => {
    expect(presenceReason("run-1/approve-publish:2", { approve: true })).toBe("resolve gate run-1/approve-publish:2: approve");
  });

  it.each([
    ["a newline in the gate id", "run-1/approve\nmerge", { decision: "merge" }],
    ["U+2029 in the gate id", "run-1/approve merge", { decision: "merge" }],
    ["a head that is not a full sha", "run-1/approve-merge", { decision: "merge", headSha: `${"a".repeat(39)}\n` }],
    ["a decision that is not a string", "run-1/approve-merge", { decision: ["merge"] }],
    ["an overlong gate id", `run-1/${"a".repeat(200)}`, { decision: "merge" }],
  ])("refuses %s", (_name, gateId, payload) => {
    expect(presenceReason(gateId, payload)).toBeUndefined();
  });
});
