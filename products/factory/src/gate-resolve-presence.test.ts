import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { GateResolver } from "@titan-design/hitl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "./definition.js";
import { mintPresenceRecord } from "./gate-resolve-presence.js";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { keyIdOf } from "./presence-proof.js";
import { TEST_BRIEF } from "./test-support/brief.js";
import { fakeOwnerSigner } from "./test-support/owner-edges.js";

const HEAD = "b".repeat(40);
const ANSWER = { decision: "merge", headSha: HEAD };

const merge = defineWorkflow({
  name: "merge",
  steps: [{ id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    await ctx.assisted("approve-merge", "Merge?", { schema: z.object({ decision: z.enum(["merge", "abandon"]), headSha: z.string() }), brief: TEST_BRIEF });
  },
});

const dirs: string[] = [];
const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

async function pausedGates(count: number): Promise<{ host: FactoryHost; gates: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "factory-gate-presence-"));
  dirs.push(dir);
  const host = openFactoryHost({ dbPath: join(dir, "factory.sqlite3"), workflows: [merge], routes: [], gatePollMs: 10 });
  hosts.push(host);
  const runs = Array.from({ length: count }, () => host.runtime.start("merge"));
  await vi.waitFor(() => expect(runs.map((id) => host.runtime.status(id)?.status)).toEqual(runs.map(() => "paused")));
  return { host, gates: runs.map((id) => `${id}/approve-merge`) };
}

const ownerWith = (confirmEvent: string): GateResolver => ({ class: "owner-terminal", id: userInfo().username, channel: "factory-cli", confirmEvent });

async function minted(host: FactoryHost, gate: string): Promise<string> {
  const result = await mintPresenceRecord(host.batches, gate, ANSWER, `resolve gate ${gate}: merge at ${HEAD}`);
  if ("refusal" in result) throw new Error(result.refusal);
  return result.confirmEvent;
}

/** A ledger row an agent wrote itself: well-formed, but signed by a key that is not in the owner's ring. */
function selfMintedRecord(host: FactoryHost, gate: string): string {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const iat = Math.floor(Date.now() / 1000);
  const nonce = "c".repeat(32);
  const statement = JSON.stringify({ v: 1, type: "titan-factory.gate-presence", aud: hostname(), keyId: keyIdOf(publicKey), nonce, iat, exp: iat + 60, items: [{ gate, payload: ANSWER }] });
  const signature = sign("sha256", Buffer.from(statement), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
  const id = randomUUID();
  host.batches.open({ id, keyId: keyIdOf(publicKey), nonce, digest: "d".repeat(64), statement, signature, aud: hostname(), iat, exp: iat + 60 }, [{ gate, repo: "", pr: 0, headSha: "" }]);
  return `gate-batch:${id}`;
}

describe("the gate store checks a gate resolve's presence proof against the ledger", () => {
  it.each([
    ["a bare UUID", () => randomUUID()],
    ["an unknown ledger id", () => `gate-batch:${randomUUID()}`],
  ])("%s is refused and the gate stays pending", async (_name, forged) => {
    const { host, gates: [gate] } = await pausedGates(1);
    fakeOwnerSigner();

    expect(() => host.gates.resolve(gate!, ANSWER, ownerWith(forged()))).toThrow(/names no owner-signed record/);
    expect(host.gates.get(gate!)?.status).toBe("pending");
  });

  it("a record an agent signed with its own key is refused", async () => {
    const { host, gates: [gate] } = await pausedGates(1);
    fakeOwnerSigner();

    expect(() => host.gates.resolve(gate!, ANSWER, ownerWith(selfMintedRecord(host, gate!)))).toThrow(/bad-signature/);
    expect(host.gates.get(gate!)?.status).toBe("pending");
  });

  it("an owner-signed record resolves its gate once, and a replay is refused", async () => {
    const { host, gates: [gate] } = await pausedGates(1);
    fakeOwnerSigner();
    const spent = await minted(host, gate!);
    expect(() => host.gates.resolve(gate!, { decision: "merge" }, ownerWith(spent))).toThrow(/payload/);

    expect(() => host.gates.resolve(gate!, ANSWER, ownerWith(spent))).toThrow(/already used/);
    expect(host.gates.get(gate!)?.status).toBe("pending");
    host.gates.resolve(gate!, ANSWER, ownerWith(await minted(host, gate!)));
    expect(host.gates.get(gate!)?.status).toBe("resolved");
  });

  it("a record signed for another gate is refused, and still resolves its own", async () => {
    const { host, gates: [own, other] } = await pausedGates(2);
    fakeOwnerSigner();
    const proof = await minted(host, own!);

    expect(() => host.gates.resolve(other!, ANSWER, ownerWith(proof))).toThrow(/not signed for gate/);
    expect(host.gates.get(other!)?.status).toBe("pending");
    host.gates.resolve(own!, ANSWER, ownerWith(proof));
    expect(host.gates.get(own!)?.status).toBe("resolved");
  });
});
