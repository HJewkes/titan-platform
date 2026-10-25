import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { GateResolver } from "@titan-design/hitl";
import { afterEach, describe, expect, it } from "vitest";
import { holdItemId } from "./hold-release-proof.js";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { mintHoldReleaseRecord, type OwnerHeldAt } from "./owner-release-presence.js";
import { holdDigest, keyIdOf } from "./presence-proof.js";
import { ownerHeldAt, ownerRelease } from "./shepherd/owner-release.js";
import { OWNER_GATE_POLICY } from "./shepherd/policy.js";
import { H1, REPO } from "./test-support/land.js";
import { fakeOwnerSigner } from "./test-support/owner-edges.js";
import { shepherdFixture } from "./test-support/shepherd.js";

const OWNER = "owner-asked: discuss scope; demo#1";
const OTHER_OWNER = "owner-asked: second look; demo#1";
const H2 = "b".repeat(40);

const hosts: FactoryHost[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

/** Two registered runs, `run-1` on PR 1 and `run-2` on PR 2, both at `H1` and both under the owner-asked hold `OWNER`. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "factory-owner-release-presence-"));
  dirs.push(dir);
  const fixture = shepherdFixture({ frozen: true });
  const prs = [fixture.fake.addPr({ headSha: H1 }).number, fixture.fake.addPr({ headSha: H1 }).number];
  const host = openFactoryHost({ dbPath: join(dir, "factory.sqlite3"), workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  const { store: storeRef, port } = fixture.routes.shepherd!;
  prs.forEach((pr, index) => {
    storeRef.get().register({ repo: REPO, pr, runId: `run-${index + 1}`, task: `demo/${pr}`, implementer: "impl-a", policy: OWNER_GATE_POLICY });
    storeRef.get().hold(`run-${index + 1}`, OWNER);
  });
  const store = () => storeRef.get();
  const heldAt = (run: string, head = H1): OwnerHeldAt => ownerHeldAt(store(), run, { repo: REPO, pr: store().byRun(run)!.pr!, head });
  const release = (run: string, resolver: GateResolver) => ownerRelease(store(), port, { repo: REPO, pr: store().byRun(run)!.pr!, head: H1 }, resolver, host.batches);
  return { host, store, heldAt, release };
}

type World = ReturnType<typeof world>;

const ownerWith = (confirmEvent: string): GateResolver => ({ class: "owner-terminal", id: userInfo().username, channel: "factory-cli", confirmEvent });

async function minted(w: World, held: OwnerHeldAt): Promise<string> {
  const result = await mintHoldReleaseRecord(w.host.batches, held, `release the owner-asked hold on ${held.repo}#${held.pr} at ${held.head}`);
  if ("refusal" in result) throw new Error(result.refusal);
  return result.confirmEvent;
}

/** A ledger row whose statement binds `signed` but whose one item names `held`'s run, signed by `signBytes`. */
function recordedRow(w: World, held: OwnerHeldAt, signed: OwnerHeldAt, keyId: string, signBytes: (bytes: Uint8Array) => string): string {
  const iat = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString("hex");
  const item = { runId: signed.runId, repo: signed.repo, pr: signed.pr, holdDigest: holdDigest(signed.ownerHold.reason), holdSince: signed.ownerHold.at, headSha: signed.head };
  const statement = JSON.stringify({ v: 1, type: "titan-factory.hold-release", aud: hostname(), keyId, nonce, iat, exp: iat + 60, items: [item] });
  const id = randomUUID();
  const record = { id, keyId, nonce, digest: item.holdDigest, statement, signature: signBytes(Buffer.from(statement)), aud: hostname(), iat, exp: iat + 60 };
  w.host.batches.open(record, [{ gate: holdItemId(held.runId), repo: held.repo, pr: held.pr, headSha: held.head }]);
  return `gate-batch:${id}`;
}

/** The same row signed by a key outside the owner's ring, as an agent minting its own proof would. */
function agentSignedRow(w: World, held: OwnerHeldAt): string {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return recordedRow(w, held, held, keyIdOf(publicKey), (bytes) => sign("sha256", bytes, { key: privateKey, dsaEncoding: "der" }).toString("base64url"));
}

const ownerKeyIdOf = (event: string, w: World): string => w.host.batches.get(event.slice("gate-batch:".length))!.keyId;

describe("ownerRelease checks an owner-release presence proof against the ledger", () => {
  it("an owner-signed hold-release record lifts its hold once and is spent", async () => {
    const w = world();
    fakeOwnerSigner();
    const proof = await minted(w, w.heldAt("run-1"));

    const after = await w.release("run-1", ownerWith(proof));

    expect(after).toMatchObject({ ownerHold: null });
    expect(w.host.batches.get(proof.slice("gate-batch:".length))?.items.map((item) => item.outcome)).toEqual(["resolved"]);
    w.store().hold("run-1", OWNER);
    await expect(w.release("run-1", ownerWith(proof))).rejects.toMatchObject({ code: 77, message: expect.stringContaining("already used") });
  });

  it("a bare UUID is refused and the hold stays", async () => {
    const w = world();
    fakeOwnerSigner();

    await expect(w.release("run-1", ownerWith(randomUUID()))).rejects.toMatchObject({ code: 77, message: expect.stringContaining("names no owner-signed record") });
    expect(w.store().byRun("run-1")?.ownerHold).toMatchObject({ reason: OWNER });
  });

  it("a record an agent signed with its own key is refused", async () => {
    const w = world();
    fakeOwnerSigner();

    await expect(w.release("run-1", ownerWith(agentSignedRow(w, w.heldAt("run-1"))))).rejects.toMatchObject({ code: 77, message: expect.stringContaining("bad-signature") });
    expect(w.store().byRun("run-1")?.ownerHold).toMatchObject({ reason: OWNER });
  });

  it("a record signed for another PR's hold is refused, and still lifts its own", async () => {
    const w = world();
    fakeOwnerSigner();
    const proof = await minted(w, w.heldAt("run-1"));

    await expect(w.release("run-2", ownerWith(proof))).rejects.toMatchObject({ code: 77, message: expect.stringContaining("not signed for run run-2 alone") });
    expect(w.store().byRun("run-2")?.ownerHold).toMatchObject({ reason: OWNER });
    await expect(w.release("run-1", ownerWith(proof))).resolves.toMatchObject({ ownerHold: null });
  });

  it("an owner statement signed for another head is refused", async () => {
    const w = world();
    const { signBytes } = fakeOwnerSigner();
    const keyId = ownerKeyIdOf(await minted(w, w.heldAt("run-2")), w);

    const proof = recordedRow(w, w.heldAt("run-1"), w.heldAt("run-1", H2), keyId, signBytes);

    await expect(w.release("run-1", ownerWith(proof))).rejects.toMatchObject({ code: 77, message: expect.stringContaining(`signed for head ${H2}`) });
    expect(w.store().byRun("run-1")?.ownerHold).toMatchObject({ reason: OWNER });
  });

  it("an owner statement signed for an earlier owner-asked hold is refused once another is placed", async () => {
    const w = world();
    fakeOwnerSigner();
    const proof = await minted(w, w.heldAt("run-1"));
    w.store().releaseOwnerHold("run-1");
    w.store().hold("run-1", OTHER_OWNER);

    await expect(w.release("run-1", ownerWith(proof))).rejects.toMatchObject({ code: 77, message: expect.stringContaining("another owner-asked hold") });
    expect(w.store().byRun("run-1")?.ownerHold).toMatchObject({ reason: OTHER_OWNER });
  });
});
