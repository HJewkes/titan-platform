import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubPort, PullRequest } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyHoldRelease, holdItemId, type HoldReleaseOutcome } from "./hold-release-proof.js";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { holdDigest, itemsDigest, keyIdOf, keyRing, type HoldReleaseItem } from "./presence-proof.js";
import { shepherdEventMigration } from "./shepherd/events.js";
import { OWNER_GATE_POLICY } from "./shepherd/policy.js";
import { holdSlotsMigration } from "./shepherd/store-migrations.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./shepherd/store.js";

const REPO = "example-org/example-repo";
const AUD = "factory.test";
const NOW_MS = 1_791_500_000_000;
const PR = 7;
const RUN = "run-1";
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const REASON = "g10-adversary: authority change; TP-1";

const owner = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const KEYS = keyRing([owner.publicKey]);
const KEY_ID = keyIdOf(owner.publicKey);

const dirs: string[] = [];
const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

interface Rig {
  host: FactoryHost;
  store: ShepherdStore;
  heads: { current: string };
}

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "factory-hold-release-"));
  dirs.push(dir);
  const host = openFactoryHost({ dbPath: join(dir, "factory.sqlite3"), workflows: [], routes: [] });
  hosts.push(host);
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19)]);
  const store = new ShepherdStore(db, () => NOW_MS);
  store.register({ repo: REPO, pr: PR, runId: RUN, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  store.hold(RUN, REASON, undefined, { actor: "seat-a" });
  return { host, store, heads: { current: HEAD } };
}

const item = (over: Partial<HoldReleaseItem> = {}): HoldReleaseItem => ({ runId: RUN, repo: REPO, pr: PR, holdDigest: holdDigest(REASON), headSha: HEAD, ...over });

function proofOf(statementOver: Record<string, unknown> = {}, nonce = randomBytes(16).toString("hex")) {
  const iat = NOW_MS / 1000;
  const statement = { v: 1, type: "titan-factory.hold-release", aud: AUD, keyId: KEY_ID, nonce, iat, exp: iat + 120, items: [item()], ...statementOver };
  const bytes = Buffer.from(JSON.stringify(statement));
  return { statementB64: bytes.toString("base64url"), signatureB64: sign("sha256", bytes, { key: owner.privateKey, dsaEncoding: "der" }).toString("base64url") };
}

function apply(r: Rig, proof: ReturnType<typeof proofOf>): Promise<HoldReleaseOutcome> {
  const port: Pick<GitHubPort, "getPr"> = { getPr: async () => ({ state: "open", headSha: r.heads.current }) as PullRequest };
  return applyHoldRelease(r.host, r.store, proof, KEYS, { now: () => NOW_MS, aud: AUD, port });
}

const releases = (r: Rig) => r.store.eventsOf(RUN).filter((event) => event.kind === "release");

describe("applyHoldRelease", () => {
  it("releases a g10-adversary hold on a valid owner proof and records the key as the actor", async () => {
    const r = rig();

    const outcome = await apply(r, proofOf());

    expect(outcome).toMatchObject({ ok: true, runId: RUN, actor: `key:${KEY_ID}` });
    expect(r.store.byRun(RUN)?.held).toBe(false);
    expect(releases(r)).toEqual([expect.objectContaining({ kind: "release", actor: `key:${KEY_ID}`, headSha: HEAD })]);
    const batchId = (outcome as { batchId: string }).batchId;
    expect(r.host.batches.get(batchId)?.items).toEqual([expect.objectContaining({ gate: holdItemId(RUN), outcome: "resolved" })]);
  });

  it("refuses a replayed nonce and writes nothing more", async () => {
    const r = rig();
    const nonce = randomBytes(16).toString("hex");
    await apply(r, proofOf({}, nonce));
    r.store.hold(RUN, REASON);

    const replay = await apply(r, proofOf({}, nonce));

    expect(replay).toMatchObject({ ok: false, refusal: "replayed-nonce" });
    expect(r.store.byRun(RUN)?.held).toBe(true);
    expect(releases(r)).toHaveLength(1);
  });

  it("refuses a proof signed for a reason the run is no longer held under", async () => {
    const r = rig();
    const proof = proofOf();
    r.store.release(RUN);
    r.store.hold(RUN, "g10-adversary: a different concern; TP-1");
    const before = releases(r).length;

    const outcome = await apply(r, proof);

    expect(outcome).toMatchObject({ ok: false, refusal: "hold-changed" });
    expect(r.store.byRun(RUN)?.held).toBe(true);
    expect(releases(r)).toHaveLength(before);
  });

  it("refuses when the PR head moved after signing, leaves the hold, and records the item skipped-moved", async () => {
    const r = rig();
    r.heads.current = MOVED;

    const outcome = await apply(r, proofOf());

    expect(outcome).toMatchObject({ ok: false, refusal: "head-moved" });
    expect(r.store.byRun(RUN)?.held).toBe(true);
    expect(releases(r)).toEqual([]);
    expect(r.host.batches.get((outcome as { batchId: string }).batchId)?.items).toEqual([expect.objectContaining({ outcome: "skipped-moved" })]);
  });

  it("refuses a proof naming another run for the PR", async () => {
    const r = rig();

    const outcome = await apply(r, proofOf({ items: [item({ runId: "run-other" })] }));

    expect(outcome).toMatchObject({ ok: false, refusal: "run-mismatch" });
    expect(r.store.byRun(RUN)?.held).toBe(true);
  });

  it("refuses a run that is not held", async () => {
    const r = rig();
    r.store.release(RUN);

    expect(await apply(r, proofOf())).toMatchObject({ ok: false, refusal: "not-held" });
  });

  it("refuses a gate-resolve statement even when the owner signed it", async () => {
    const r = rig();
    const gateItem = { gate: `${RUN}/approve-merge`, runId: RUN, stepId: "approve-merge", repo: REPO, pr: PR, headSha: HEAD, payload: {} };

    const outcome = await apply(r, proofOf({ type: "titan-factory.gate-resolve", digest: itemsDigest([gateItem]), items: [gateItem] }));

    expect(outcome).toMatchObject({ ok: false, refusal: "malformed" });
    expect(r.store.byRun(RUN)?.held).toBe(true);
  });

  it("refuses a proof signed for another factory", async () => {
    const r = rig();

    expect(await apply(r, proofOf({ aud: "other.host" }))).toMatchObject({ ok: false, refusal: "wrong-aud" });
    expect(r.store.byRun(RUN)?.held).toBe(true);
  });
});
