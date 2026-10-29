import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { ownerKeyId } from "../owner-presence.js";
import { keyIdOf } from "../presence-proof.js";
import { fakeOwnerSigner } from "../test-support/owner-edges.js";
import { BEFORE_OPEN, H, REPO, evidence, evidenceStep, gateOn, reads, verdictText, weakened } from "../test-support/owner-evidence.js";
import { resolveGate } from "./gate.js";
import { ownerEvidence } from "./owner-evidence.js";

/** TP-4404, TP-4491: a console tap on an owner-at-head merge gate resolves only on the card's digest and the owner's signed presence. */
const H2 = "c".repeat(40);
const CONFIRM = `action:${"d".repeat(64)}`;
const TEXT = verdictText("CI-policy: weakened secrets");

type Presence = { statementB64: string; signatureB64: string };
type Signer = { keyId: string; signBytes: (bytes: Uint8Array) => string };

/** A `titan-factory.gate-presence` statement over `payload` for `gate`, signed by `signer`. */
function presenceFor(signer: Signer, gate: string, payload: Record<string, string>): Presence {
  const iat = Math.floor(Date.now() / 1000);
  const statement = { v: 1, type: "titan-factory.gate-presence", aud: hostname(), keyId: signer.keyId, nonce: randomBytes(16).toString("hex"), iat, exp: iat + 60, items: [{ gate, payload }] };
  const bytes = Buffer.from(JSON.stringify(statement), "utf8");
  return { statementB64: bytes.toString("base64url"), signatureB64: signer.signBytes(bytes) };
}

async function owner(): Promise<Signer> {
  const { signBytes } = fakeOwnerSigner();
  return { keyId: (await ownerKeyId())!, signBytes };
}

/** An agent's own P-256 key: well-formed signatures from a key outside the owner's ring. */
function forger(): Signer {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { keyId: keyIdOf(publicKey), signBytes: (bytes) => sign("sha256", bytes, { key: privateKey, dsaEncoding: "der" }).toString("base64url") };
}

const tap = (gateId: string, headSha: string, evidenceDigest?: string, presence?: Presence) => ({
  action: { kind: "resolve-gate" as const, gateId, runId: gateId.slice(0, gateId.indexOf("/")), stepId: "approve-merge", repo: REPO, pr: 1, headSha, decision: "merge", ...(evidenceDigest !== undefined && { evidenceDigest }), ...(presence && { presence }) },
  confirmEvent: CONFIRM,
});

async function weakenedGate() {
  const stored = evidence(weakened("secrets"));
  const world = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)]);
  const card = await ownerEvidence(world.gate, { host: world.host, port: world.port, readText: reads(TEXT) });
  const digest = card.status === "ready" ? card.digest : "";
  return { ...world, digest, signed: (signer: Signer, payload = { decision: "merge", headSha: H, evidenceDigest: digest }) => presenceFor(signer, world.gate.id, payload) };
}

describe("a console tap on an owner-at-head gate", () => {
  it("merges at the pinned head on the digest of the card shown and the owner's signed presence, naming the facts it covered", async () => {
    const { host, port, gate, digest, signed } = await weakenedGate();
    const presence = signed(await owner());

    const outcome = await resolveGate(tap(gate.id, H, digest, presence), port, host, reads(TEXT));

    expect(outcome).toEqual({ outcome: "resolved", gateId: gate.id, covered: ["ci-policy-weakened"] });
    expect(host.gates.get(gate.id)).toMatchObject({ status: "resolved", payload: { decision: "merge", headSha: H }, resolvedBy: { class: "owner-remote", confirmEvent: CONFIRM } });
  });

  it("refuses a digest of another card, so evidence that changed after the owner read it never merges", async () => {
    const { host, port, gate, signed } = await weakenedGate();
    const presence = signed(await owner(), { decision: "merge", headSha: H, evidenceDigest: "e".repeat(64) });

    const outcome = await resolveGate(tap(gate.id, H, "e".repeat(64), presence), port, host, reads(TEXT));

    expect(outcome).toMatchObject({ outcome: "refused", reason: "evidence", detail: `the evidence for ${gate.id} changed since it was shown; read the item again` });
    expect(host.gates.get(gate.id)?.status).toBe("pending");
  });

  it("refuses a tap with no digest, naming the terminal command", async () => {
    const { host, port, gate } = await weakenedGate();

    const outcome = await resolveGate(tap(gate.id, H), port, host, reads(TEXT));

    expect(outcome).toMatchObject({ outcome: "refused", reason: "class", detail: expect.stringContaining(`run titan-factory gate resolve ${gate.id.replace("/", " ")}`) });
    expect(host.gates.get(gate.id)?.status).toBe("pending");
  });

  it("refuses the card's public digest with no presence statement, so an agent cannot forge the owner's tap", async () => {
    const { host, port, gate, digest } = await weakenedGate();

    const outcome = await resolveGate(tap(gate.id, H, digest), port, host, reads(TEXT));

    expect(outcome).toMatchObject({ outcome: "refused", reason: "class", detail: expect.stringContaining("the owner's signed presence; run titan-factory gate resolve") });
    expect(host.gates.get(gate.id)?.status).toBe("pending");
  });

  it("refuses a presence statement signed by a key outside the owner's ring", async () => {
    const { host, port, gate, digest, signed } = await weakenedGate();
    await owner();

    const outcome = await resolveGate(tap(gate.id, H, digest, signed(forger())), port, host, reads(TEXT));

    expect(outcome).toMatchObject({ outcome: "refused", reason: "resolver", detail: expect.stringContaining("the presence statement was refused") });
    expect(host.gates.get(gate.id)?.status).toBe("pending");
  });

  it("refuses an owner statement that names no evidence digest, as a terminal resolve's does", async () => {
    const { host, port, gate, digest, signed } = await weakenedGate();
    const presence = signed(await owner(), { decision: "merge", headSha: H });

    const outcome = await resolveGate(tap(gate.id, H, digest, presence), port, host, reads(TEXT));

    expect(outcome).toMatchObject({ outcome: "refused", reason: "resolver", detail: expect.stringContaining("signed for another answer") });
    expect(host.gates.get(gate.id)?.status).toBe("pending");
  });

  it("reads a tap at a head other than the gate's as moved, even when the PR is now at that head", async () => {
    const { host, fake, port, gate, digest, signed } = await weakenedGate();
    const presence = signed(await owner(), { decision: "merge", headSha: H2, evidenceDigest: digest });
    fake.pushHead(1, H2);

    const outcome = await resolveGate(tap(gate.id, H2, digest, presence), port, host, reads(TEXT));

    expect(outcome).toEqual({ outcome: "moved", currentHead: H });
    expect(host.gates.get(gate.id)?.status).toBe("pending");
  });

  it("refuses a digest on a gate that asks for no evidence as a record fault", async () => {
    const stored = evidence();
    const { host, port, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)], "shepherd-merge-guard/reviewed-merge");

    const outcome = await resolveGate(tap(gate.id, H, "e".repeat(64)), port, host, reads(TEXT));

    expect(outcome).toMatchObject({ outcome: "refused", reason: "record", detail: `${gate.id} asks for no evidence, yet the record carries a digest` });
    expect(host.gates.get(gate.id)?.status).toBe("pending");
  });
});
