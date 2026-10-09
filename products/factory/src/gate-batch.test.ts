import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubPort, PullRequest } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "./definition.js";
import { applyProof, type ApplyDeps } from "./gate-batch.js";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { itemsDigest, keyIdOf, keyRing, type ProofItem } from "./presence-proof.js";
import { TEST_BRIEF } from "./test-support/brief.js";

const REPO = "example-org/example-repo";
const AUD = "factory.test";
const NOW_MS = 1_791_500_000_000;
const sha = (char: string): string => char.repeat(40);

const owner = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const stranger = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const KEYS = keyRing([owner.publicKey]);
const KEY_ID = keyIdOf(owner.publicKey);

const mergeGate = defineWorkflow({
  name: "merge-gate",
  steps: [{ id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    const [pr, head, rule] = [ctx.param("pr")!, ctx.param("head")!, ctx.param("rule")!];
    const prompt = `Merge PR #${pr} in ${REPO} at head ${head}? CI is green. Policy ${rule}: synthetic reason`;
    await ctx.assisted("approve-merge", prompt, { schema: z.object({ decision: z.enum(["merge", "abandon"]), headSha: z.literal(head) }), brief: TEST_BRIEF });
  },
});

const ackGate = defineWorkflow({
  name: "ack-gate",
  steps: [{ id: "main-red", kind: "assisted" }],
  run: async (ctx) => {
    await ctx.assisted("main-red", "Main is red. Acknowledge.", { schema: z.object({ decision: z.literal("acknowledged"), mergeSha: z.string() }), brief: TEST_BRIEF });
  },
});

const dirs: string[] = [];
const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function openHost(): FactoryHost {
  const dir = mkdtempSync(join(tmpdir(), "factory-gate-batch-"));
  dirs.push(dir);
  const host = openFactoryHost({ dbPath: join(dir, "factory.sqlite3"), workflows: [mergeGate, ackGate], routes: [], gatePollMs: 10 });
  hosts.push(host);
  return host;
}

async function gated(host: FactoryHost, pr: number, head: string, rule = "authority/MRG-AU"): Promise<ProofItem> {
  const runId = host.runtime.start("merge-gate", { pr: String(pr), head, rule });
  await vi.waitFor(() => expect(host.gates.get(`${runId}/approve-merge`)?.status).toBe("pending"));
  return { gate: `${runId}/approve-merge`, runId, stepId: "approve-merge", repo: REPO, pr, headSha: head, payload: { decision: "merge", headSha: head } };
}

const atHead = (item: ProofItem, head: string): ProofItem => ({ ...item, headSha: head, payload: { decision: "merge", headSha: head } });

interface ProofOptions {
  key?: KeyObject;
  nonce?: string;
}

function proofOf(items: readonly ProofItem[], { key = owner.privateKey, nonce = randomBytes(16).toString("hex") }: ProofOptions = {}) {
  const iat = NOW_MS / 1000;
  const statement = { v: 1, type: "titan-factory.gate-resolve", aud: AUD, keyId: KEY_ID, nonce, iat, exp: iat + 120, digest: itemsDigest(items), items };
  const bytes = Buffer.from(JSON.stringify(statement));
  return { statementB64: bytes.toString("base64url"), signatureB64: sign("sha256", bytes, { key, dsaEncoding: "der" }).toString("base64url") };
}

function fakePort(prs: Record<number, Partial<PullRequest>>): Pick<GitHubPort, "getPr"> {
  return { getPr: async (_repo, pr) => ({ state: "open", headSha: "", ...prs[pr] }) as PullRequest };
}

const deps = (extra: Partial<ApplyDeps> = {}): ApplyDeps => ({ now: () => NOW_MS, aud: AUD, ...extra });

describe("applyProof", () => {
  it("resolves N gates from one proof, each as the owner's key with the batch as its confirm event", async () => {
    const host = openHost();
    const items = [await gated(host, 1, sha("a")), await gated(host, 2, sha("b")), await gated(host, 3, sha("c"))];

    const result = await applyProof(host, proofOf(items), KEYS, deps());

    expect(result).toMatchObject({ ok: true, items: items.map(({ gate }) => ({ gate, outcome: "resolved" })) });
    const batchId = result.ok ? result.batchId : "";
    for (const item of items) {
      expect(host.gates.get(item.gate)).toMatchObject({
        status: "resolved",
        payload: item.payload,
        resolvedBy: { class: "owner-terminal", id: `key:${KEY_ID}`, channel: "factory-proof", confirmEvent: `proof:${batchId}` },
      });
    }
  });

  it("refuses a replayed nonce and resolves nothing from the replay", async () => {
    const host = openHost();
    const first = await gated(host, 1, sha("a"));
    const second = await gated(host, 2, sha("b"));
    const nonce = randomBytes(16).toString("hex");
    await applyProof(host, proofOf([first], { nonce }), KEYS, deps());

    const replay = await applyProof(host, proofOf([second], { nonce }), KEYS, deps());

    expect(replay).toMatchObject({ ok: false, refusal: "replayed-nonce" });
    expect(host.gates.get(second.gate)?.status).toBe("pending");
  });

  it("skips and names a gate whose head moved, and resolves the rest", async () => {
    const host = openHost();
    const kept = await gated(host, 1, sha("a"));
    const moved = atHead(await gated(host, 2, sha("b")), sha("e"));

    const result = await applyProof(host, proofOf([kept, moved]), KEYS, deps());

    expect(result).toMatchObject({ ok: true, items: [{ gate: kept.gate, outcome: "resolved" }, { gate: moved.gate, outcome: "skipped-moved", detail: expect.stringContaining(sha("b")) }] });
    expect(host.gates.get(moved.gate)?.status).toBe("pending");
  });

  it("skips a gate whose PR head moved on GitHub since the gate was asked", async () => {
    const host = openHost();
    const item = await gated(host, 1, sha("a"));

    const result = await applyProof(host, proofOf([item]), KEYS, deps({ port: fakePort({ 1: { headSha: sha("f") } }) }));

    expect(result).toMatchObject({ ok: true, items: [{ outcome: "skipped-moved" }] });
    expect(host.gates.get(item.gate)?.status).toBe("pending");
  });

  it("skips a gate whose PR closed, whether GitHub says so or the gate was cancelled", async () => {
    const host = openHost();
    const closedOnGitHub = await gated(host, 1, sha("a"));
    const cancelled = await gated(host, 2, sha("b"));
    host.gates.cancel(cancelled.gate, "the pull request was closed");

    const result = await applyProof(host, proofOf([closedOnGitHub, cancelled]), KEYS, deps({ port: fakePort({ 1: { state: "closed", headSha: sha("a") }, 2: { headSha: sha("b") } }) }));

    expect(result).toMatchObject({ ok: true, items: [{ outcome: "skipped-closed" }, { outcome: "skipped-closed" }] });
    expect(host.gates.get(closedOnGitHub.gate)?.status).toBe("pending");
  });

  it("refuses an item whose run or step does not match its gate id, and resolves nothing", async () => {
    const host = openHost();
    const good = await gated(host, 1, sha("a"));
    const other = await gated(host, 2, sha("b"));
    const crossed = { ...other, runId: good.runId };

    const result = await applyProof(host, proofOf([good, crossed]), KEYS, deps());

    expect(result).toMatchObject({ ok: false, refusal: "malformed" });
    expect(host.gates.get(good.gate)?.status).toBe("pending");
  });

  it("refuses a batch holding a shepherd-release merge gate, which only the gate record shows", async () => {
    const host = openHost();
    const merge = await gated(host, 1, sha("a"));
    const release = await gated(host, 2, sha("b"), "shepherd-release/owner-gate");

    const result = await applyProof(host, proofOf([merge, release]), KEYS, deps());

    expect(result).toMatchObject({ ok: false, refusal: "item-refused", detail: expect.stringContaining(`${release.gate} is a release gate`) });
    expect(host.gates.get(merge.gate)?.status).toBe("pending");
  });

  it("applies a single-item proof for a release gate", async () => {
    const host = openHost();
    const release = await gated(host, 2, sha("b"), "shepherd-release/owner-gate");

    const result = await applyProof(host, proofOf([release]), KEYS, deps());

    expect(result).toMatchObject({ ok: true, items: [{ outcome: "resolved" }] });
  });

  it("applies a single-item proof's payload to a gate that is not a merge gate", async () => {
    const host = openHost();
    const runId = host.runtime.start("ack-gate");
    await vi.waitFor(() => expect(host.gates.get(`${runId}/main-red`)?.status).toBe("pending"));
    const payload = { decision: "acknowledged", mergeSha: sha("9") };
    const item: ProofItem = { gate: `${runId}/main-red`, runId, stepId: "main-red", repo: REPO, pr: 4, headSha: sha("9"), payload };

    const result = await applyProof(host, proofOf([item]), KEYS, deps());

    expect(result).toMatchObject({ ok: true, items: [{ outcome: "resolved" }] });
    expect(host.gates.get(item.gate)).toMatchObject({ status: "resolved", payload, resolvedBy: { id: `key:${KEY_ID}` } });
  });

  it("refuses a batch item that is not a merge answer at its own head", async () => {
    const host = openHost();
    const merge = await gated(host, 1, sha("a"));
    const abandon = { ...(await gated(host, 2, sha("b"))), payload: { decision: "abandon", headSha: sha("b") } };

    const result = await applyProof(host, proofOf([merge, abandon]), KEYS, deps());

    expect(result).toMatchObject({ ok: false, refusal: "item-refused" });
    expect(host.gates.get(merge.gate)?.status).toBe("pending");
  });

  it.each([
    ["an unknown gate", (item: ProofItem) => ({ ...item, gate: "no-such-run/approve-merge", runId: "no-such-run" }), "no gate"],
    ["another PR than the gate's", (item: ProofItem) => ({ ...item, pr: 7 }), "asks about"],
  ])("refuses a proof naming %s and records nothing", async (_label, bend, detail) => {
    const host = openHost();
    const item = await gated(host, 1, sha("a"));

    const result = await applyProof(host, proofOf([bend(item)]), KEYS, deps());

    expect(result).toMatchObject({ ok: false, refusal: "item-refused", detail: expect.stringContaining(detail) });
    expect(host.gates.get(item.gate)?.status).toBe("pending");
  });

  it("resolves nothing from a forged signature", async () => {
    const host = openHost();
    const item = await gated(host, 1, sha("a"));

    const result = await applyProof(host, proofOf([item], { key: stranger.privateKey }), KEYS, deps());

    expect(result).toMatchObject({ ok: false, refusal: "bad-signature" });
    expect(host.gates.get(item.gate)?.status).toBe("pending");
  });

  it("records the batch with its statement, signature and every item's outcome", async () => {
    const host = openHost();
    const kept = await gated(host, 1, sha("a"));
    const moved = atHead(await gated(host, 2, sha("b")), sha("e"));
    const proof = proofOf([kept, moved]);

    const result = await applyProof(host, proof, KEYS, deps());

    const record = host.batches.get(result.ok ? result.batchId : "");
    expect(record).toMatchObject({ keyId: KEY_ID, aud: AUD, statement: Buffer.from(proof.statementB64, "base64url").toString("utf8"), signature: proof.signatureB64 });
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

    const result = await applyProof(host, proofOf(items), KEYS, deps());

    expect(result).toMatchObject({ ok: true, items: [{ outcome: "resolved" }, { outcome: "failed", detail: "database is locked" }, { outcome: "signed" }] });
    expect(host.batches.get(result.ok ? result.batchId : "")?.items.map((item) => item.outcome)).toEqual(["resolved", "failed", "signed"]);
    expect(host.gates.get(items[2]!.gate)?.status).toBe("pending");
  });
});
