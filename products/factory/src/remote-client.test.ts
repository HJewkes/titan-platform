import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CLIENT_HEADER } from "@titan-design/daemon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "./exit-codes.js";
import { RemoteFailedError, remoteFactory, UnavailableError } from "./remote-client.js";

const BASE = "http://127.0.0.1:7410";
const GATE = {
  gateId: "g-1",
  runId: "run-1",
  stepId: "approve-merge",
  repo: "example-org/example-repo",
  pr: 12,
  headSha: "a".repeat(40),
  rule: "authority/MRG-AU",
  batchable: true,
  verdict: null,
  checks: { state: "green", failing: [] },
  createdAt: "2026-10-14T00:00:00.000Z",
};

function answering(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(text, { status }));
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => {
    server.closeAllConnections();
    return new Promise((done) => server.close(done));
  }));
});

async function listening(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("remoteFactory requests", () => {
  it("sends every request to <base><path> with the client header and a timeout signal", async () => {
    const fetchSpy = answering(200, { ok: true, data: { aud: "basement", gates: [GATE] } });
    const remote = remoteFactory(`${BASE}/`, fetchSpy);

    await remote.gatesReview();
    await remote.postProof("/gates/resolve-proof", { statement: "s", signature: "t" }).catch(() => undefined);
    await remote.ownerKeyIds().catch(() => undefined);

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      `${BASE}/rpc/factory.gates-review`,
      `${BASE}/gates/resolve-proof`,
      `${BASE}/health`,
    ]);
    for (const [, init] of fetchSpy.mock.calls) {
      expect(new Headers(init?.headers).get(CLIENT_HEADER)).toBe("titan-factory");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("posts the proof body as JSON and returns the route's status and body, refusals included", async () => {
    const fetchSpy = answering(409, { error: "replayed-nonce", detail: "seen" });

    const answer = await remoteFactory(BASE, fetchSpy).postProof("/gates/resolve-proof", { statement: "s", signature: "t" });

    expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)).toEqual({ statement: "s", signature: "t" });
    expect(answer).toEqual({ status: 409, body: { error: "replayed-nonce", detail: "seen" } });
  });

  it("refuses a remoteFactory that is not an http URL before any request", () => {
    const fetchSpy = answering(200, {});

    expect(() => remoteFactory("file:///etc/passwd", fetchSpy)).toThrow(RemoteFailedError);
    expect(() => remoteFactory("not a url", fetchSpy)).toThrow(/is not a URL/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("remoteFactory answers", () => {
  it("returns the remote's aud and gates from factory.gates-review", async () => {
    const review = await remoteFactory(BASE, answering(200, { ok: true, data: { aud: "basement", gates: [GATE] } })).gatesReview();

    expect(review).toEqual({ aud: "basement", gates: [GATE] });
  });

  it("reports an error envelope from factory.gates-review as a failure naming the error", async () => {
    const remote = remoteFactory(BASE, answering(500, { ok: false, error: "database is locked", code: 70 }));

    await expect(remote.gatesReview()).rejects.toThrow(/factory\.gates-review at http:\/\/127\.0\.0\.1:7410 failed: database is locked/);
  });

  it("reports a gate row without batchability as an unexpected shape, not a gate", async () => {
    const rowWithoutBatchable: Record<string, unknown> = { ...GATE };
    delete rowWithoutBatchable.batchable;
    const remote = remoteFactory(BASE, answering(200, { ok: true, data: { aud: "basement", gates: [rowWithoutBatchable] } }));

    await expect(remote.gatesReview()).rejects.toThrow(/unexpected shape/);
  });

  it("returns the installed owner key ids from /health", async () => {
    const remote = remoteFactory(BASE, answering(200, { ok: true, ownerKeys: { count: 2, ids: ["0123456789abcdef", "fedcba9876543210"] } }));

    expect(await remote.ownerKeyIds()).toEqual(["0123456789abcdef", "fedcba9876543210"]);
  });

  it("returns no owner key ids when /health reports the key ring refused", async () => {
    const remote = remoteFactory(BASE, answering(200, { ok: true, ownerKeys: { count: 0, refusal: "/etc/titan-factory/owner-keys is missing" } }));

    expect(await remote.ownerKeyIds()).toEqual([]);
  });

  it("maps a body that is not JSON to a failure with exit 1, and says a posted proof may have applied", async () => {
    const remote = remoteFactory(BASE, answering(502, "<html>Bad Gateway</html>"));

    await expect(remote.ownerKeyIds()).rejects.toMatchObject({ exit: EXIT.FAILURE, message: expect.stringMatching(/HTTP 502 with a body that is not JSON/) });
    await expect(remote.postProof("/gates/resolve-proof", { statement: "s", signature: "t" })).rejects.toThrow(/may still have been applied/);
  });
});

describe("remoteFactory unavailable", () => {
  it("reports a refused connection as unavailable, naming the URL and the ssh LocalForward", async () => {
    const base = await listening(createServer());
    await new Promise((done) => servers.pop()!.close(done));

    const failure = await remoteFactory(base).ownerKeyIds().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UnavailableError);
    expect(failure).toMatchObject({ exit: EXIT.UNAVAILABLE });
    expect((failure as Error).message).toContain(`${base}/health`);
    expect((failure as Error).message).toMatch(/ECONNREFUSED.*LocalForward/);
  });

  it("reports a remote that never answers as unavailable once the timeout passes", async () => {
    const base = await listening(createServer(() => undefined));

    const failure = await remoteFactory(base, fetch, 50).gatesReview().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(UnavailableError);
    expect((failure as Error).message).toMatch(/did not answer within 0\.05 s/);
  });
});
