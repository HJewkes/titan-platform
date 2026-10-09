import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActorClass } from "@titan-design/authority";
import { MemoryGateStore, type GateResolver } from "@titan-design/hitl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FACTORY_ANSWER_ALLOWANCES } from "./coordinator-allowances.js";
import { defineWorkflow } from "./definition.js";
import { deviceGateAuthorize } from "./device-gates.js";
import { applyProof } from "./gate-batch.js";
import { itemsRefusal } from "./gate-batch-plan.js";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { itemsDigest, keyIdOf, keyRing, verifyProof, type ProofItem } from "./presence-proof.js";
import { TEST_BRIEF } from "./test-support/brief.js";

const HEAD = "a".repeat(40);
const PASS = { decision: "pass", headSha: HEAD };
const AUD = "factory.test";
const NOW_MS = 1_791_500_000_000;
const ownerKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const KEYS = keyRing([ownerKey.publicKey]);

const deviceGate = defineWorkflow({
  name: "device-gate",
  steps: [
    { id: "device-confirm", kind: "assisted" },
    { id: "approve-publish", kind: "assisted" },
  ],
  run: async (ctx) => {
    const schema = z.object({ decision: z.enum(["pass", "fail"]), headSha: z.literal(HEAD) });
    await ctx.assisted(ctx.param("step")!, "Did the device step pass at this head?", { schema, brief: TEST_BRIEF });
  },
});

const dirs: string[] = [];
const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function openHost(): FactoryHost {
  const dir = mkdtempSync(join(tmpdir(), "factory-device-gates-"));
  dirs.push(dir);
  const host = openFactoryHost({ dbPath: join(dir, "factory.sqlite3"), workflows: [deviceGate], routes: [], gatePollMs: 10 });
  hosts.push(host);
  return host;
}

async function pendingGate(host: FactoryHost, step = "device-confirm"): Promise<{ runId: string; gateId: string }> {
  const runId = host.runtime.start("device-gate", { step });
  const gateId = `${runId}/${step}`;
  await vi.waitFor(() => expect(host.gates.get(gateId)?.status).toBe("pending"));
  return { runId, gateId };
}

const resolverOf = (actorClass: ActorClass, channel = "factory-cli"): GateResolver => ({ class: actorClass, id: `a-${actorClass}`, channel });

function proofOf(items: readonly ProofItem[]) {
  const iat = NOW_MS / 1000;
  const statement = { v: 1, type: "titan-factory.gate-resolve", aud: AUD, keyId: keyIdOf(ownerKey.publicKey), nonce: randomBytes(16).toString("hex"), iat, exp: iat + 120, digest: itemsDigest(items), items };
  const bytes = Buffer.from(JSON.stringify(statement));
  return { statementB64: bytes.toString("base64url"), signatureB64: sign("sha256", bytes, { key: ownerKey.privateKey, dsaEncoding: "der" }).toString("base64url") };
}

const itemOf = (runId: string, gateId: string, step = "device-confirm"): ProofItem => ({ gate: gateId, runId, stepId: step, repo: "octo/demo", pr: 7, headSha: HEAD, payload: PASS });

describe("a device gate on the factory host", () => {
  it("resolves for the owner at the factory's terminal", async () => {
    const host = openHost();
    const { runId, gateId } = await pendingGate(host);

    host.runtime.signal(runId, "device-confirm", PASS, resolverOf("owner-terminal"));

    expect(host.gates.get(gateId)?.status).toBe("resolved");
  });

  it.each([
    ["an agent session", "worker", /worker may not resolve/],
    ["a headless agent", "headless", /headless may not resolve/],
    ["automation", "automation", /automation may not resolve/],
    ["the decider", "decider", /decider may not resolve/],
    ["a seat coordinator", "coordinator", /coordinator may not resolve/],
    ["the owner over a remote channel", "owner-remote", /device gate .* only to owner-terminal/],
  ] as const)("refuses %s and stays pending", async (_who, actorClass, reason) => {
    const host = openHost();
    const { runId, gateId } = await pendingGate(host);

    expect(() => host.runtime.signal(runId, "device-confirm", PASS, resolverOf(actorClass))).toThrow(reason);

    expect(host.gates.get(gateId)?.status).toBe("pending");
  });

  it("refuses an owner-signed resolve-proof posted from another host and stays pending", async () => {
    const host = openHost();
    const { runId, gateId } = await pendingGate(host);

    const result = await applyProof(host, proofOf([itemOf(runId, gateId)]), KEYS, { now: () => NOW_MS, aud: AUD });

    expect(result).toMatchObject({ ok: true, items: [{ gate: gateId, outcome: "failed", detail: expect.stringMatching(/only through factory-cli, not factory-proof/) }] });
    expect(host.gates.get(gateId)?.status).toBe("pending");
  });

  it("refuses a remote owner on a repeat device gate id with a :<n> suffix", () => {
    const store = new MemoryGateStore({ authorize: deviceGateAuthorize });
    const gate = store.create({ id: "run-1/device-confirm:2", prompt: "Did it pass?" });

    expect(() => store.resolve(gate.id, PASS, resolverOf("owner-remote"))).toThrow(/only to owner-terminal/);

    expect(store.get(gate.id)?.status).toBe("pending");
  });

  it("leaves a gate that is not a device gate open to the remote owner", async () => {
    const host = openHost();
    const { runId, gateId } = await pendingGate(host, "approve-publish");

    host.runtime.signal(runId, "approve-publish", PASS, resolverOf("owner-remote", "relay"));

    expect(host.gates.get(gateId)?.status).toBe("resolved");
  });
});

describe("a coordinator answer to a device gate", () => {
  it("has no factory allowance", () => {
    expect(FACTORY_ANSWER_ALLOWANCES.filter(({ stepId }) => /device/.test(stepId))).toEqual([]);
  });

  it("is refused even where an allowance would admit it", () => {
    const allowances = [{ resolverClass: "coordinator", stepId: "device-confirm", payload: PASS }] as const;
    const store = new MemoryGateStore({ authorize: deviceGateAuthorize, allowances });
    const gate = store.create({ id: "run-1/device-confirm", prompt: "Did it pass?" });

    expect(() => store.resolve(gate.id, PASS, resolverOf("coordinator"))).toThrow(/only to owner-terminal/);

    expect(store.get(gate.id)?.status).toBe("pending");
  });

  it("is refused where a gate rule names the coordinator a delegate", () => {
    const store = new MemoryGateStore({ authorize: deviceGateAuthorize });
    const rule = { table: "example-table", version: "1", ruleId: "merge-approval", resolvers: ["owner-terminal" as const], delegates: ["coordinator" as const] };
    const gate = store.create({ id: "run-1/approve-merge", prompt: "Merge?", rule });

    expect(() => store.resolve(gate.id, { decision: "merge" }, resolverOf("coordinator"))).toThrow(/admit no rule delegate/);
  });
});

describe("device-confirm and the one-per-proof hardware rule", () => {
  it("is refused in a signed batch by presence-proof", async () => {
    const host = openHost();
    const device = await pendingGate(host);
    const other = await pendingGate(host);
    const items = [itemOf(device.runId, device.gateId), itemOf(other.runId, other.gateId)];

    expect(verifyProof(proofOf(items), KEYS, NOW_MS / 1000, AUD)).toEqual({ ok: false, refusal: "mixed-release-batch" });
  });

  it("is refused in a batch by the gate-batch plan", async () => {
    const host = openHost();
    const device = await pendingGate(host);
    const other = await pendingGate(host);

    expect(itemsRefusal(host, [itemOf(device.runId, device.gateId), itemOf(other.runId, other.gateId)])).toMatch(/is a hardware gate/);
  });
});
