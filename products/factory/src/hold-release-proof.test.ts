import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyHoldRelease, holdItemId, holdSinceOf, type HoldReleaseOutcome } from "./hold-release-proof.js";
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
  /** What GitHub answers for the PR: its head, or an error; `during` runs inside the read. */
  github: { head: string; error?: Error; during?: () => void };
}

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "factory-hold-release-"));
  dirs.push(dir);
  const host = openFactoryHost({ dbPath: join(dir, "factory.sqlite3"), workflows: [], routes: [] });
  hosts.push(host);
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19)]);
  let clock = NOW_MS;
  const store = new ShepherdStore(db, () => (clock += 1000));
  store.register({ repo: REPO, pr: PR, runId: RUN, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  store.hold(RUN, REASON, undefined, { actor: "seat-a" });
  return { host, store, github: { head: HEAD } };
}

/** The item the owner signs for the hold as it stands now. */
const item = (r: Rig, over: Partial<HoldReleaseItem> = {}): HoldReleaseItem => ({
  runId: RUN,
  repo: REPO,
  pr: PR,
  holdDigest: holdDigest(REASON),
  holdSince: holdSinceOf(r.store, RUN)!,
  headSha: HEAD,
  ...over,
});

function proofOf(r: Rig, statementOver: Record<string, unknown> = {}, nonce = randomBytes(16).toString("hex")) {
  const iat = NOW_MS / 1000;
  const statement = { v: 1, type: "titan-factory.hold-release", aud: AUD, keyId: KEY_ID, nonce, iat, exp: iat + 120, items: [item(r)], ...statementOver };
  const bytes = Buffer.from(JSON.stringify(statement));
  return { statementB64: bytes.toString("base64url"), signatureB64: sign("sha256", bytes, { key: owner.privateKey, dsaEncoding: "der" }).toString("base64url") };
}

function apply(r: Rig, proof: ReturnType<typeof proofOf>): Promise<HoldReleaseOutcome> {
  const port = {
    getPr: async () => {
      r.github.during?.();
      if (r.github.error) throw r.github.error;
      return { headSha: r.github.head };
    },
  };
  return applyHoldRelease(r.host, r.store, proof, KEYS, { now: () => NOW_MS, aud: AUD, port });
}

const batchItems = (r: Rig, outcome: HoldReleaseOutcome) => r.host.batches.get(outcome.batchId ?? "")?.items;
const releases = (r: Rig) => r.store.eventsOf(RUN).filter((event) => event.kind === "release");

describe("applyHoldRelease", () => {
  it("releases a g10-adversary hold on a valid owner proof and records the key as the actor", async () => {
    const r = rig();

    const outcome = await apply(r, proofOf(r));

    expect(outcome).toMatchObject({ ok: true, runId: RUN, actor: `key:${KEY_ID}` });
    expect(r.store.byRun(RUN)?.held).toBe(false);
    expect(releases(r)).toEqual([expect.objectContaining({ kind: "release", actor: `key:${KEY_ID}`, headSha: HEAD })]);
    expect(batchItems(r, outcome)).toEqual([expect.objectContaining({ gate: holdItemId(RUN), outcome: "resolved" })]);
  });

  it("refuses a replayed nonce and writes nothing more", async () => {
    const r = rig();
    const nonce = randomBytes(16).toString("hex");
    await apply(r, proofOf(r, {}, nonce));
    r.store.hold(RUN, REASON);

    const replay = await apply(r, proofOf(r, {}, nonce));

    expect(replay).toMatchObject({ ok: false, refusal: "replayed-nonce" });
    expect(r.store.byRun(RUN)?.held).toBe(true);
    expect(releases(r)).toHaveLength(1);
  });

  it("refuses a proof signed for a reason the run is no longer held under", async () => {
    const r = rig();
    const proof = proofOf(r);
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
    r.github.head = MOVED;

    const outcome = await apply(r, proofOf(r));

    expect(outcome).toMatchObject({ ok: false, refusal: "head-moved" });
    expect(r.store.byRun(RUN)?.held).toBe(true);
    expect(releases(r)).toEqual([]);
    expect(batchItems(r, outcome)).toEqual([expect.objectContaining({ outcome: "skipped-moved" })]);
  });

  it("refuses a second proof for an earlier hold that a re-hold with the same text replaced", async () => {
    const r = rig();
    const earlier = proofOf(r);
    await apply(r, proofOf(r));
    r.store.hold(RUN, REASON);

    const outcome = await apply(r, earlier);

    expect(outcome).toMatchObject({ ok: false, refusal: "hold-changed" });
    expect(r.store.byRun(RUN)?.held).toBe(true);
    expect(releases(r)).toHaveLength(1);
  });

  it("spends the proof and leaves the hold when GitHub cannot be read", async () => {
    const r = rig();
    const proof = proofOf(r);
    r.github.error = new Error("502 bad gateway");

    const outcome = await apply(r, proof);
    r.github.error = undefined;
    const retry = await apply(r, proof);

    expect(outcome).toMatchObject({ ok: false, refusal: "head-unreadable" });
    expect(batchItems(r, outcome)).toEqual([expect.objectContaining({ outcome: "skipped-unreadable" })]);
    expect(retry).toMatchObject({ ok: false, refusal: "replayed-nonce" });
    expect(r.store.byRun(RUN)?.held).toBe(true);
  });

  it("leaves a hold that changed while the PR head was read", async () => {
    const r = rig();
    r.github.during = () => void r.store.hold(RUN, "g10-adversary: a different concern; TP-1");

    const outcome = await apply(r, proofOf(r));

    expect(outcome).toMatchObject({ ok: false, refusal: "hold-changed" });
    expect(batchItems(r, outcome)).toEqual([expect.objectContaining({ outcome: "skipped-moved" })]);
    expect(r.store.byRun(RUN)).toMatchObject({ held: true, holdReason: "g10-adversary: a different concern; TP-1" });
    expect(releases(r)).toEqual([]);
  });

  it("refuses a proof naming another run for the PR", async () => {
    const r = rig();

    const outcome = await apply(r, proofOf(r, { items: [item(r, { runId: "run-other" })] }));

    expect(outcome).toMatchObject({ ok: false, refusal: "run-mismatch" });
    expect(r.store.byRun(RUN)?.held).toBe(true);
  });

  it("refuses a run that is not held", async () => {
    const r = rig();
    r.store.release(RUN);

    expect(await apply(r, proofOf(r))).toMatchObject({ ok: false, refusal: "not-held" });
  });

  it("refuses a gate-resolve statement even when the owner signed it", async () => {
    const r = rig();
    const gateItem = { gate: `${RUN}/approve-merge`, runId: RUN, stepId: "approve-merge", repo: REPO, pr: PR, headSha: HEAD, payload: {} };

    const outcome = await apply(r, proofOf(r, { type: "titan-factory.gate-resolve", digest: itemsDigest([gateItem]), items: [gateItem] }));

    expect(outcome).toMatchObject({ ok: false, refusal: "malformed" });
    expect(r.store.byRun(RUN)?.held).toBe(true);
  });

  it("refuses a proof signed for another factory", async () => {
    const r = rig();

    expect(await apply(r, proofOf(r, { aud: "other.host" }))).toMatchObject({ ok: false, refusal: "wrong-aud" });
    expect(r.store.byRun(RUN)?.held).toBe(true);
  });
});
