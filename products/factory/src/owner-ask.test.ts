import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSha } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "./definition.js";
import { approveMergeDecision } from "./gate-brief.js";
import { resolveGate, resolveGateByOwnerAsk } from "./gate-resolve.js";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { ownerAskResolver } from "./owner-ask.js";
import { TEST_BRIEF } from "./test-support/brief.js";
import { fakeOwnerSigner } from "./test-support/owner-edges.js";

const REPO = "o/r";
const HEAD = fakeSha("head");
const SEAT = "tc-synthetic";
const SEAT_SHELL = { AGENT_CHAT_AGENT_ID: "agent-1", AGENT_CHAT_NAME: SEAT };
const MERGE = JSON.stringify({ decision: "merge", headSha: HEAD });

/** Opens one gate: an approve-merge land gate under the `rule` param, or the device step a device PR asks the owner to confirm. */
const gates = defineWorkflow({
  name: "owner-ask-gates",
  steps: [
    { id: "approve-merge", kind: "assisted" },
    { id: "device-flash", kind: "assisted" },
  ],
  run: async (ctx) => {
    if (ctx.param("gate") === "device") {
      await ctx.assisted("device-flash", "Flash the board and confirm.", { schema: z.object({ decision: z.enum(["merge", "abandon"]), headSha: z.string() }), brief: TEST_BRIEF });
      return;
    }
    const reason = "the reviewer's MERGE stands";
    const prompt = `Merge PR #1 in ${REPO} at head ${HEAD}? CI is green. Policy ${ctx.param("rule")!}: ${reason}`;
    await ctx.assisted("approve-merge", prompt, approveMergeDecision({ repo: REPO, pr: 1, headSha: HEAD, reason, reviewedMerge: true }));
  },
});

const dirs: string[] = [];
const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

async function paused(params: Record<string, string>): Promise<{ host: FactoryHost; runId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "factory-owner-ask-"));
  dirs.push(dir);
  const host = openFactoryHost({ dbPath: join(dir, "factory.sqlite3"), workflows: [gates], routes: [], gatePollMs: 10 });
  hosts.push(host);
  const runId = host.runtime.start("owner-ask-gates", params);
  await vi.waitFor(() => expect(host.runtime.status(runId)?.status).toBe("paused"));
  return { host, runId };
}

function ownerAsk(host: FactoryHost, runId: string, stepId = "approve-merge", env: NodeJS.ProcessEnv = SEAT_SHELL) {
  let out = "";
  let err = "";
  const io = { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t), env };
  let code: number;
  try {
    code = resolveGateByOwnerAsk(host, io, runId, stepId, MERGE);
  } catch (error) {
    err += (error as Error).message;
    code = 1;
  }
  return { code, out, err };
}

describe("gate resolve --owner-ask", () => {
  it("resolves an approve-merge gate under a judgement rule and records the seat as owner-ask, not the owner", async () => {
    const { host, runId } = await paused({ rule: "shepherd-merge-guard/visual-path" });

    const { code, out } = ownerAsk(host, runId);

    expect(code).toBe(0);
    expect(out).toBe(`resolved ${runId}/approve-merge as owner-ask by ${SEAT}\n`);
    expect(host.gates.get(`${runId}/approve-merge`)).toMatchObject({ status: "resolved", resolvedBy: { class: "owner-ask", id: SEAT, channel: "factory-cli" } });
    await vi.waitFor(() => expect(host.runtime.status(runId)?.status).toBe("completed"));
  });

  it.each([
    ["a publish rule", { rule: "shepherd-release/version-packages" }, "approve-merge", "publish rule shepherd-release/version-packages"],
    ["an owner-presence rule", { rule: "shepherd-merge-guard/ci-policy-weakened" }, "approve-merge", "owner-presence rule ci-policy-weakened"],
    ["a device gate", { gate: "device" }, "device-flash", "rule HW-CO"],
  ])("refuses %s, names the rule, and leaves the gate pending", async (_name, params, stepId, named) => {
    const { host, runId } = await paused(params);

    const { code, err } = ownerAsk(host, runId, stepId);

    expect(code).toBe(1);
    expect(err).toContain("refused a resolution by owner-ask");
    expect(err).toContain(named);
    expect(host.gates.get(`${runId}/${stepId}`)).toMatchObject({ status: "pending", resolvedBy: undefined });
  });

  it("refuses a shell that names no seat before touching the gate", async () => {
    const { host, runId } = await paused({ rule: "shepherd-merge-guard/visual-path" });

    const { code, err } = ownerAsk(host, runId, "approve-merge", {});

    expect(code).toBe(2);
    expect(err).toContain("AGENT_CHAT_NAME is not set");
    expect(host.gates.get(`${runId}/approve-merge`)?.status).toBe("pending");
  });

  it("refuses an owner-ask resolver that arrives without its own evidence", async () => {
    const { host, runId } = await paused({ rule: "shepherd-merge-guard/visual-path" });

    expect(() => host.runtime.signal(runId, "approve-merge", JSON.parse(MERGE), ownerAskResolver(SEAT))).toThrow(/refused a resolution by owner-ask/);
    expect(host.gates.get(`${runId}/approve-merge`)?.status).toBe("pending");
  });

  it("leaves a plain resolve from the same seat on the owner-presence path", async () => {
    const { host, runId } = await paused({ rule: "shepherd-merge-guard/visual-path" });
    fakeOwnerSigner();
    const io = { stdout: () => {}, stderr: () => {}, env: SEAT_SHELL };

    await resolveGate(host, io, runId, "approve-merge", MERGE);

    expect(host.gates.get(`${runId}/approve-merge`)?.resolvedBy?.class).toBe("owner-terminal");
  });
});
