import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubPort, PullRequest } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runCli } from "./cli.js";
import { defineWorkflow } from "./definition.js";
import { resolveBatch, type BatchDeps } from "./gate-batch.js";
import type { OwnerPresence } from "./gate-resolve.js";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { TEST_BRIEF } from "./test-support/brief.js";

const PROOF = "0b6f2c1e-6f1d-4c3a-9e1b-2d4c6a8e0f13";
const AGENT_SHELL = { AGENT_CHAT_AGENT_ID: "agent-1", AGENT_CHAT_NAME: "tc-synthetic" };
const REPO = "example-org/example-repo";
const sha = (char: string): string => char.repeat(40);

const mergeGate = defineWorkflow({
  name: "merge-gate",
  steps: [{ id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    const [pr, head, rule] = [ctx.param("pr")!, ctx.param("head")!, ctx.param("rule")!];
    const prompt = `Merge PR #${pr} in ${REPO} at head ${head}? CI is green. Policy ${rule}: synthetic reason`;
    await ctx.assisted("approve-merge", prompt, { schema: z.object({ decision: z.enum(["merge", "abandon"]), headSha: z.literal(head) }), brief: TEST_BRIEF });
  },
});

const deviceGate = defineWorkflow({
  name: "device-gate",
  steps: [{ id: "actuate-device", kind: "assisted" }],
  run: async (ctx) => {
    await ctx.assisted("actuate-device", "Actuate?", { schema: z.object({ decision: z.enum(["merge"]), headSha: z.string() }), brief: TEST_BRIEF });
  },
});

const dirs: string[] = [];
const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function openHost(dbPath = join(scratch(), "factory.sqlite3")): FactoryHost {
  const host = openFactoryHost({ dbPath, workflows: [mergeGate, deviceGate], routes: [], gatePollMs: 10 });
  hosts.push(host);
  return host;
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-gate-batch-"));
  dirs.push(dir);
  return dir;
}

interface Gated {
  gate: string;
  pr: string;
  headSha: string;
}

async function gated(host: FactoryHost, pr: number, head: string, rule = "authority/MRG-AU"): Promise<Gated> {
  const runId = host.runtime.start("merge-gate", { pr: String(pr), head, rule });
  await vi.waitFor(() => expect(host.gates.get(`${runId}/approve-merge`)?.status).toBe("pending"));
  return { gate: `${runId}/approve-merge`, pr: `${REPO}#${pr}`, headSha: head };
}

async function deviceGated(host: FactoryHost): Promise<Gated> {
  const runId = host.runtime.start("device-gate");
  await vi.waitFor(() => expect(host.gates.get(`${runId}/actuate-device`)?.status).toBe("pending"));
  return { gate: `${runId}/actuate-device`, pr: `${REPO}#99`, headSha: sha("d") };
}

function presenceStub(proof: string | undefined, out: () => string = () => ""): { presence: OwnerPresence; reasons: string[]; seen: string[] } {
  const reasons: string[] = [];
  const seen: string[] = [];
  return { reasons, seen, presence: async (reason) => (reasons.push(reason), seen.push(out()), proof) };
}

function fakePort(prs: Record<number, Partial<PullRequest>>): Pick<GitHubPort, "getPr"> {
  return { getPr: async (_repo, pr) => ({ state: "open", headSha: "", ...prs[pr] }) as PullRequest };
}

async function run(host: FactoryHost, items: readonly unknown[], deps: Partial<BatchDeps> & { proof?: string | undefined } = {}) {
  let out = "";
  let err = "";
  const io = { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t), env: AGENT_SHELL };
  const stub = presenceStub("proof" in deps ? deps.proof : PROOF, () => out);
  const source = items.map((item) => JSON.stringify(item)).join("\n");
  const code = await resolveBatch(host, io, source, { presence: stub.presence, ...deps });
  return { code, out, err, prompts: stub.reasons, seenAtPrompt: stub.seen };
}

const batchIdOf = (out: string): string => /signed batch ([0-9a-f-]{36})/.exec(out)![1]!;

describe("gate resolve-batch", () => {
  it("asks for owner presence once for N merge gates, after printing the itemized list, and resolves each", async () => {
    const host = openHost();
    const items = [await gated(host, 1, sha("a")), await gated(host, 2, sha("b")), await gated(host, 3, sha("c"))];

    const { code, prompts, seenAtPrompt } = await run(host, items);

    expect(code).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/^resolve 3 merge gates as batch [0-9a-f]{16}$/);
    for (const item of items) expect(seenAtPrompt[0]).toContain(`${item.gate}  ${item.pr}  ${item.headSha}`);
    for (const item of items) expect(host.gates.get(item.gate)).toMatchObject({ status: "resolved", payload: { decision: "merge", headSha: item.headSha }, resolvedBy: { confirmEvent: PROOF } });
  });

  it("skips and names a gate whose head moved, and resolves the rest", async () => {
    const host = openHost();
    const kept = await gated(host, 1, sha("a"));
    const moved = { ...(await gated(host, 2, sha("b"))), headSha: sha("e") };

    const { code, out } = await run(host, [kept, moved]);

    expect(code).toBe(0);
    expect(out).toContain(`skipped ${moved.gate}: moved`);
    expect(host.gates.get(moved.gate)?.status).toBe("pending");
    expect(host.gates.get(kept.gate)?.status).toBe("resolved");
  });

  it("skips a gate whose PR head moved on GitHub since the gate was asked", async () => {
    const host = openHost();
    const item = await gated(host, 1, sha("a"));

    const { out } = await run(host, [item], { port: fakePort({ 1: { headSha: sha("f") } }) });

    expect(out).toContain(`skipped ${item.gate}: moved`);
    expect(host.gates.get(item.gate)?.status).toBe("pending");
  });

  it("skips a gate whose PR was closed, whether GitHub says so or the gate was cancelled", async () => {
    const host = openHost();
    const closedOnGitHub = await gated(host, 1, sha("a"));
    const cancelled = await gated(host, 2, sha("b"));
    host.gates.cancel(cancelled.gate, "the pull request was closed");

    const { code, out } = await run(host, [closedOnGitHub, cancelled], { port: fakePort({ 1: { state: "closed", headSha: sha("a") }, 2: { headSha: sha("b") } }) });

    expect(code).toBe(0);
    expect(out).toContain(`skipped ${closedOnGitHub.gate}: closed`);
    expect(out).toContain(`skipped ${cancelled.gate}: closed`);
    expect(host.gates.get(closedOnGitHub.gate)?.status).toBe("pending");
  });

  it("refuses a batch holding a release gate, with no prompt and nothing resolved", async () => {
    const host = openHost();
    const merge = await gated(host, 1, sha("a"));
    const release = await gated(host, 2, sha("b"), "shepherd-release/owner-gate");

    const { code, err, prompts } = await run(host, [merge, release]);

    expect(code).toBe(2);
    expect(err).toContain(`${release.gate} is a release gate`);
    expect(prompts).toEqual([]);
    expect(host.gates.get(merge.gate)?.status).toBe("pending");
  });

  it("refuses a batch holding a hardware gate", async () => {
    const host = openHost();
    const device = await deviceGated(host);

    const { code, err, prompts } = await run(host, [await gated(host, 1, sha("a")), device]);

    expect(code).toBe(2);
    expect(err).toContain(`${device.gate} is a hardware gate`);
    expect(prompts).toEqual([]);
  });

  it("resolves nothing and records no batch when presence is denied", async () => {
    const host = openHost();
    const items = [await gated(host, 1, sha("a")), await gated(host, 2, sha("b"))];

    const { code, err, prompts } = await run(host, items, { proof: undefined });

    expect(code).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(err).toContain("owner presence was not confirmed");
    for (const item of items) expect(host.gates.get(item.gate)?.status).toBe("pending");
  });

  it.each([
    ["an unknown gate id", [{ gate: "no-such-run/approve-merge", pr: `${REPO}#1`, headSha: sha("a") }]],
    ["a malformed head sha", [{ gate: "x/approve-merge", pr: `${REPO}#1`, headSha: "abc" }]],
    ["an extra field", [{ gate: "x/approve-merge", pr: `${REPO}#1`, headSha: sha("a"), decision: "abandon" }]],
  ])("resolves nothing and asks nothing for %s", async (_label, bad) => {
    const host = openHost();
    const good = await gated(host, 1, sha("a"));

    const { code, prompts } = await run(host, [good, ...bad]);

    expect(code).toBe(2);
    expect(prompts).toEqual([]);
    expect(host.gates.get(good.gate)?.status).toBe("pending");
  });

  it("resolves nothing and asks nothing for an empty list or a line that is not an object", async () => {
    const host = openHost();

    const empty = await run(host, []);
    const garbled = await run(host, ["{"]);

    expect([empty.code, garbled.code]).toEqual([2, 2]);
    expect([...empty.prompts, ...garbled.prompts]).toEqual([]);
  });

  it("refuses an item whose PR is not the PR its gate asks about", async () => {
    const host = openHost();
    const item = { ...(await gated(host, 1, sha("a"))), pr: `${REPO}#7` };

    const { code, err } = await run(host, [item]);

    expect(code).toBe(2);
    expect(err).toContain(`${item.gate} asks about ${REPO}#1, not ${REPO}#7`);
  });

  it("records the signed batch with every item and its outcome", async () => {
    const host = openHost();
    const kept = await gated(host, 1, sha("a"));
    const moved = { ...(await gated(host, 2, sha("b"))), headSha: sha("e") };

    const { out } = await run(host, [kept, moved]);

    const record = host.batches.get(batchIdOf(out));
    expect(record).toMatchObject({ proof: PROOF, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(record?.items).toEqual([
      { gate: kept.gate, repo: REPO, pr: 1, headSha: sha("a"), outcome: "resolved" },
      { gate: moved.gate, repo: REPO, pr: 2, headSha: sha("e"), outcome: "skipped-moved", detail: expect.stringContaining(sha("b")) },
    ]);
  });

  it("stops at a store error mid-batch and leaves a record of which items fired", async () => {
    const host = openHost();
    const items = [await gated(host, 1, sha("a")), await gated(host, 2, sha("b")), await gated(host, 3, sha("c"))];
    const signal = host.runtime.signal.bind(host.runtime);
    let calls = 0;
    vi.spyOn(host.runtime, "signal").mockImplementation((...args) => {
      if (++calls === 2) throw new Error("database is locked");
      signal(...args);
    });

    const { code, out } = await run(host, items);

    expect(code).toBe(1);
    expect(host.batches.get(batchIdOf(out))?.items.map((item) => item.outcome)).toEqual(["resolved", "failed", "signed"]);
    expect(host.gates.get(items[2]!.gate)?.status).toBe("pending");
  });

  describe("the CLI verb", () => {
    async function cli(dbPath: string, args: string[], presence: OwnerPresence) {
      let out = "";
      let err = "";
      const io = { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t), env: AGENT_SHELL };
      const code = await runCli(["--db", dbPath, "gate", "resolve-batch", ...args], io, { workflows: [mergeGate, deviceGate], routes: [], host: { gatePollMs: 10 }, presence });
      return { code, out, err };
    }

    it("reads the items from a JSON lines file and resolves them after one presence check", async () => {
      const dir = scratch();
      const dbPath = join(dir, "factory.sqlite3");
      const setup = openHost(dbPath);
      const items = [await gated(setup, 1, sha("a")), await gated(setup, 2, sha("b"))];
      setup.runtime.shutdown();
      const file = join(dir, "batch.jsonl");
      writeFileSync(file, items.map((item) => JSON.stringify(item)).join("\n"));
      const stub = presenceStub(PROOF);

      const { code } = await cli(dbPath, ["--file", file], stub.presence);

      expect(code).toBe(0);
      expect(stub.reasons).toHaveLength(1);
      for (const item of items) expect(setup.gates.get(item.gate)?.status).toBe("resolved");
    });

    it.each([[[]], [["--file", "x.jsonl", "--json", "[]"]]])("refuses %j: exactly one of --file or --json", async (args) => {
      const stub = presenceStub(PROOF);

      const { code, err } = await cli(join(scratch(), "factory.sqlite3"), args, stub.presence);

      expect(code).toBe(2);
      expect(err).toContain("exactly one of --file or --json");
      expect(stub.reasons).toEqual([]);
    });
  });
});
