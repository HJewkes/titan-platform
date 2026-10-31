import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_HEADER, listTools, silentLogger, type Logger } from "@titan-design/daemon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
import { defineWorkflow } from "./definition.js";
import { holdSinceOf } from "./hold-release-proof.js";
import { holdDigest, itemsDigest, keyIdOf, type ProofItem } from "./presence-proof.js";
import { createFactoryRegistry } from "./registry.js";
import { HOLD_RELEASE_PROOF_PATH, MAX_PROOF_BODY_BYTES, RESOLVE_PROOF_PATH } from "./resolve-proof.js";
import { startFactoryServer, TOOL_PREFIX, type FactoryServer, type FactoryServerOptions } from "./serve.js";
import { TEST_BRIEF } from "./test-support/brief.js";
import { rootStat, useOwnerKeyDir } from "./test-support/owner-edges.js";
import { REPO as SHEPHERD_REPO } from "./test-support/land.js";
import { callCommand, shepherdFixture } from "./test-support/shepherd.js";
import { partialFake } from "@titan-design/test-kit";
import type { FactoryContext } from "./registry.js";

const REPO = "example-org/example-repo";
const AUD = "factory.test";
const NOW_MS = 1_791_500_000_000;
const HEAD = "a".repeat(40);

const owner = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const KEY_ID = keyIdOf(owner.publicKey);

type KeyInstall = "installed" | "user-owned" | "empty" | "missing";

/** The owner's key ring on disk under the test's state dir, read through a stat that reports root ownership. */
function installOwnerKeys(root: string, install: KeyInstall): void {
  const dir = join(root, "owner-keys");
  if (install !== "missing") {
    mkdirSync(dir);
    chmodSync(dir, 0o755);
  }
  if (install === "installed" || install === "user-owned") {
    writeFileSync(join(dir, "owner.pem"), owner.publicKey.export({ type: "spki", format: "pem" }).toString());
    chmodSync(join(dir, "owner.pem"), 0o644);
  }
  useOwnerKeyDir(dir, rootStat(dir, (path, real) => (install === "user-owned" && path === dir ? { uid: 501, mode: real.mode } : undefined)));
}

const mergeGate = defineWorkflow({
  name: "merge-gate",
  steps: [{ id: "approve-merge", kind: "assisted" }],
  run: async (ctx) => {
    const [pr, head] = [ctx.param("pr")!, ctx.param("head")!];
    const prompt = `Merge PR #${pr} in ${REPO} at head ${head}? CI is green. Policy authority/MRG-AU: synthetic reason`;
    await ctx.assisted("approve-merge", prompt, { schema: z.object({ decision: z.enum(["merge", "abandon"]), headSha: z.literal(head) }), brief: TEST_BRIEF });
  },
});

const dirs: string[] = [];
const servers: FactoryServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

async function serve(overrides: Partial<FactoryServerOptions> = {}, keys: KeyInstall = "installed"): Promise<FactoryServer> {
  const dir = mkdtempSync(join(tmpdir(), "factory-resolve-proof-"));
  dirs.push(dir);
  installOwnerKeys(dir, keys);
  const server = await startFactoryServer({
    dbPath: join(dir, "factory.sqlite3"),
    workflows: [mergeGate],
    routes: [],
    now: () => NOW_MS,
    gatePollMs: 10,
    port: 0,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
    build: { sha: "test", behindMain: { status: () => 0, refresh: async () => undefined } },
    aud: AUD,
    ...overrides,
  });
  servers.push(server);
  return server;
}

async function gated(server: FactoryServer, pr: number): Promise<ProofItem> {
  const runId = server.host.runtime.start("merge-gate", { pr: String(pr), head: HEAD });
  await vi.waitFor(() => expect(server.host.gates.get(`${runId}/approve-merge`)?.status).toBe("pending"));
  return { gate: `${runId}/approve-merge`, runId, stepId: "approve-merge", repo: REPO, pr, headSha: HEAD, payload: { decision: "merge", headSha: HEAD } };
}

function proofOf(items: readonly ProofItem[], nonce = randomBytes(16).toString("hex")) {
  const iat = NOW_MS / 1000;
  const statement = { v: 1, type: "titan-factory.gate-resolve", aud: AUD, keyId: KEY_ID, nonce, iat, exp: iat + 120, digest: itemsDigest(items), items };
  const bytes = Buffer.from(JSON.stringify(statement));
  return { statement: bytes.toString("base64url"), signature: sign("sha256", bytes, { key: owner.privateKey, dsaEncoding: "der" }).toString("base64url") };
}

const post = (server: FactoryServer, body: string, path = RESOLVE_PROOF_PATH): Promise<Response> =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { "content-type": "application/json", [CLIENT_HEADER]: "test" }, body });

const health = async (server: FactoryServer): Promise<Record<string, unknown>> => {
  const body: unknown = await (await fetch(`http://127.0.0.1:${server.port}/health`)).json();
  if (!isObjectLike(body)) throw new Error("/health answered no object");
  return body;
};

describe("POST /gates/resolve-proof", () => {
  it("verifies a signed proof and resolves every item, returning per-item outcomes", async () => {
    const server = await serve();
    const items = [await gated(server, 1), await gated(server, 2)];

    const response = await post(server, JSON.stringify(proofOf(items)));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, batchId: expect.any(String), items: items.map(({ gate }) => ({ gate, outcome: "resolved" })) });
    for (const { gate } of items) expect(server.host.gates.get(gate)).toMatchObject({ status: "resolved", resolvedBy: { id: `key:${KEY_ID}`, channel: "factory-proof" } });
  });

  it("resolves a single gate from a one-item proof, as a plain gate resolve would", async () => {
    const server = await serve();
    const item = await gated(server, 1);

    const response = await post(server, JSON.stringify(proofOf([item])));

    expect(await response.json()).toMatchObject({ ok: true, items: [{ gate: item.gate, outcome: "resolved" }] });
  });

  it("refuses a replayed proof and resolves nothing from it", async () => {
    const server = await serve();
    const nonce = randomBytes(16).toString("hex");
    await post(server, JSON.stringify(proofOf([await gated(server, 1)], nonce)));
    const second = await gated(server, 2);

    const replay = await post(server, JSON.stringify(proofOf([second], nonce)));

    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ ok: false, refusal: "replayed-nonce" });
    expect(server.host.gates.get(second.gate)?.status).toBe("pending");
  });

  it("refuses a proof signed for another factory", async () => {
    const server = await serve({ aud: "other.host" });
    const item = await gated(server, 1);

    const response = await post(server, JSON.stringify(proofOf([item])));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, refusal: "wrong-aud" });
    expect(server.host.gates.get(item.gate)?.status).toBe("pending");
  });

  it("answers 503 owner keys not installed when the key directory was refused", async () => {
    const server = await serve({}, "user-owned");
    const item = await gated(server, 1);

    const response = await post(server, JSON.stringify(proofOf([item])));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: "owner keys not installed", detail: expect.stringMatching(/\/owner-keys is owned by uid 501, not root$/) });
    expect(server.host.gates.get(item.gate)?.status).toBe("pending");
  });

  it("refuses an oversize body before reading it as a proof", async () => {
    const server = await serve();

    const response = await post(server, JSON.stringify({ statement: "a".repeat(MAX_PROOF_BODY_BYTES), signature: "b" }));

    expect(response.status).toBe(413);
  });

  it("refuses an oversize chunked body that declares no length, once it passes the limit", async () => {
    const server = await serve();
    const chunk = new TextEncoder().encode("a".repeat(64 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > 2 * MAX_PROOF_BODY_BYTES) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });

    const response = await fetch(`http://127.0.0.1:${server.port}${RESOLVE_PROOF_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", [CLIENT_HEADER]: "test" },
      body,
      duplex: "half",
    } as RequestInit);

    expect(response.status).toBe(413);
  });

  it("refuses a body that is not a proof", async () => {
    const server = await serve();

    const response = await post(server, JSON.stringify({ statementB64: "x" }));

    expect(response.status).toBe(400);
  });

  it("refuses a browser-shaped request through the daemon's existing guards", async () => {
    const server = await serve();

    const response = await fetch(`http://127.0.0.1:${server.port}${RESOLVE_PROOF_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

    expect(response.status).toBe(403);
  });

  it("never logs the statement or the signature", async () => {
    const lines: string[] = [];
    const record = (...args: unknown[]): void => void lines.push(JSON.stringify(args));
    const logger: Logger = { ...silentLogger, info: record, warn: record, error: record };
    const server = await serve({ logger });
    const proof = proofOf([await gated(server, 1)]);

    await post(server, JSON.stringify(proof));
    await post(server, JSON.stringify(proof));

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(proof.signature.slice(0, 24));
    expect(lines.join("\n")).not.toContain(proof.statement.slice(0, 24));
  });

  it("is not an MCP tool or an RPC command", () => {
    const tools = listTools({ registry: createFactoryRegistry(), createContext: () => partialFake<FactoryContext>({ warnings: [], format: "json" }), toolPrefix: TOOL_PREFIX, name: "titan-factory", version: "0" });

    expect(tools.map((tool) => tool.name).filter((name) => /resolve|proof/.test(name))).toEqual([]);
    expect(createFactoryRegistry().list().map((cmd) => cmd.name).filter((name) => /resolve|proof/.test(name))).toEqual([]);
  });
});

describe("POST /holds/release-proof", () => {
  const REASON = "g10-adversary: authority change; TP-1";

  function holdProof(runId: string, pr: number, holdSince = new Date(NOW_MS).toISOString(), aud = AUD) {
    const iat = NOW_MS / 1000;
    const items = [{ runId, repo: SHEPHERD_REPO, pr, holdDigest: holdDigest(REASON), holdSince, headSha: HEAD }];
    const statement = { v: 1, type: "titan-factory.hold-release", aud, keyId: KEY_ID, nonce: randomBytes(16).toString("hex"), iat, exp: iat + 120, items };
    const bytes = Buffer.from(JSON.stringify(statement));
    return { statement: bytes.toString("base64url"), signature: sign("sha256", bytes, { key: owner.privateKey, dsaEncoding: "der" }).toString("base64url") };
  }

  async function heldShepherd(overrides: Partial<FactoryServerOptions> = {}) {
    const fixture = shepherdFixture({ frozen: true });
    const server = await serve({ workflows: fixture.workflows, routes: fixture.routes, resyncOnStart: false, ...overrides });
    const pr = fixture.fake.addPr({ headSha: HEAD }).number;
    const registered = await callCommand<{ runId: string }>(server.host, fixture.routes, "shepherd.register", { repo: SHEPHERD_REPO, pr, task: "demo/T-1", implementer: "impl-a" });
    if (!registered.ok) throw new Error(registered.error);
    const store = fixture.routes.shepherd!.store.get();
    store.hold(registered.data.runId, REASON);
    return { server, store, pr, runId: registered.data.runId, holdSince: holdSinceOf(store, registered.data.runId)! };
  }

  it("releases the hold on a valid owner proof, recording the key as the actor", async () => {
    const { server, store, pr, runId, holdSince } = await heldShepherd();

    const response = await post(server, JSON.stringify(holdProof(runId, pr, holdSince)), HOLD_RELEASE_PROOF_PATH);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, runId, actor: `key:${KEY_ID}` });
    expect(store.byRun(runId)?.held).toBe(false);
    expect(store.eventsOf(runId).filter((event) => event.kind === "release")).toEqual([expect.objectContaining({ actor: `key:${KEY_ID}` })]);
  });

  it("refuses a proof signed for another factory with 403 and leaves the hold", async () => {
    const { server, store, pr, runId, holdSince } = await heldShepherd({ aud: "other.host" });

    const response = await post(server, JSON.stringify(holdProof(runId, pr, holdSince)), HOLD_RELEASE_PROOF_PATH);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, refusal: "wrong-aud" });
    expect(store.byRun(runId)?.held).toBe(true);
  });

  it("answers 503 owner keys not installed when the key directory was refused", async () => {
    const server = await serve({}, "missing");

    const response = await post(server, JSON.stringify(holdProof("run-1", 1)), HOLD_RELEASE_PROOF_PATH);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: "owner keys not installed" });
  });

  it("refuses an oversize body before reading it as a proof", async () => {
    const server = await serve();

    const response = await post(server, JSON.stringify({ statement: "a".repeat(MAX_PROOF_BODY_BYTES), signature: "b" }), HOLD_RELEASE_PROOF_PATH);

    expect(response.status).toBe(413);
  });

  it("answers 503 when serve runs without the shepherd routes", async () => {
    const server = await serve();

    const response = await post(server, JSON.stringify(holdProof("run-1", 1)), HOLD_RELEASE_PROOF_PATH);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: "shepherd routes not mounted" });
  });

  it("refuses a browser-shaped request through the daemon's existing guards", async () => {
    const server = await serve();

    const response = await fetch(`http://127.0.0.1:${server.port}${HOLD_RELEASE_PROOF_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

    expect(response.status).toBe(403);
  });
});

describe("serve health and gates for owner proofs", () => {
  it("lists the loaded owner key ids in /health", async () => {
    const server = await serve();

    expect(await health(server)).toMatchObject({ ownerKeys: { count: 1, ids: [KEY_ID] } });
  });

  it("shows the refusal in /health when the key directory was refused", async () => {
    const server = await serve({}, "empty");

    expect(await health(server)).toMatchObject({ ownerKeys: { count: 0, refusal: expect.stringMatching(/^no \.pem key in .*\/owner-keys$/) } });
  });

  it("names the serving host as the audience in factory.gates", async () => {
    const server = await serve();

    const response = await fetch(`http://127.0.0.1:${server.port}/rpc/factory.gates`, { method: "POST", headers: { "content-type": "application/json", [CLIENT_HEADER]: "test" }, body: "{}" });

    expect(await response.json()).toMatchObject({ ok: true, data: { aud: AUD } });
  });
});
