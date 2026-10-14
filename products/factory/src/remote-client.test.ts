import { createServer, type Server } from "node:http";
import { CLIENT_HEADER } from "@titan-design/daemon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT } from "./exit-codes.js";
import { MAX_REVIEW_GATES, RemoteFailedError, remoteFactory, UnavailableError } from "./remote-client.js";
import { RESOLVE_PROOF_PATH } from "./resolve-proof.js";

const BASE = "http://127.0.0.1:7410";
const PROOF = { statement: "s", signature: "t" };
const ESC = "\u001b[31m";
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
const APPLIED = { ok: true, batchId: "b-1", items: [{ gate: "g-1", outcome: "resolved" }] };

function answering(status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(text, { status }));
}

function reviewing(data: unknown, status = 200) {
  return remoteFactory(BASE, answering(status, { ok: true, data }));
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
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no TCP address");
  return `http://127.0.0.1:${address.port}`;
}

describe("remoteFactory requests", () => {
  it("sends every request to <base><path> with the client header and a timeout signal", async () => {
    const fetchSpy = answering(200, { ok: true, data: { aud: "basement", gates: [GATE] } });
    const remote = remoteFactory(`${BASE}/`, fetchSpy);

    await remote.gatesReview();
    await remote.postProof(RESOLVE_PROOF_PATH, PROOF).catch(() => undefined);
    await remote.ownerKeyIds().catch(() => undefined);

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([`${BASE}/rpc/factory.gates-review`, `${BASE}${RESOLVE_PROOF_PATH}`, `${BASE}/health`]);
    for (const [, init] of fetchSpy.mock.calls) {
      expect(new Headers(init?.headers).get(CLIENT_HEADER)).toBe("titan-factory");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.redirect).toBe("error");
    }
  });

  it("posts the proof body as JSON and returns the route's refusal with its status", async () => {
    const fetchSpy = answering(409, { ok: false, error: "owner proof refused: replayed-nonce", code: 65, refusal: "replayed-nonce", detail: "seen" });

    const answer = await remoteFactory(BASE, fetchSpy).postProof(RESOLVE_PROOF_PATH, PROOF);

    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(PROOF));
    expect(answer).toEqual({ status: 409, body: { ok: false, error: "owner proof refused: replayed-nonce", refusal: "replayed-nonce", detail: "seen" } });
  });

  it("never follows a redirect, so a signed proof is not re-posted to Location", async () => {
    const elsewhere = vi.fn();
    const sink = await listening(createServer((req, res) => (elsewhere(req.url), res.end("{}"))));
    const base = await listening(createServer((_req, res) => res.writeHead(307, { location: `${sink}${RESOLVE_PROOF_PATH}` }).end()));

    const posting = remoteFactory(base).postProof(RESOLVE_PROOF_PATH, PROOF);

    await expect(posting).rejects.toBeInstanceOf(RemoteFailedError);
    await expect(posting).rejects.toThrow(/redirect, which is never followed/);
    expect(elsewhere).not.toHaveBeenCalled();
  });
});

describe("remoteFactory URLs", () => {
  it.each([
    ["file:///etc/passwd", /not an http\(s\) URL/],
    ["not a url", /is not a URL/],
    ["http://user:pw@127.0.0.1:7410", /carries credentials/],
    ["http://127.0.0.1:7410/?x=1", /carries a query/],
    ["http://127.0.0.1:7410/#frag", /carries a fragment/],
    ["http://127.0.0.1:7410/#", /carries a fragment/],
    ["http://127.0.0.1:7410/prefix", /carries a path/],
  ])("refuses remoteFactory %s before any request", (base, why) => {
    const fetchSpy = answering(200, {});

    expect(() => remoteFactory(base, fetchSpy)).toThrow(why);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["@evil.example/x", "gates/resolve-proof", "/gates/resolve-proof?x=1", "/gates/../gates/resolve-proof", "//evil.example/gates/resolve-proof", "/rpc/factory.gates-review"])(
    "refuses to post a proof to %s without sending it",
    async (path) => {
      const fetchSpy = answering(200, APPLIED);

      // @ts-expect-error -- the type admits only the proof routes; the runtime check is what this pins.
      await expect(remoteFactory(BASE, fetchSpy).postProof(path, PROOF)).rejects.toBeInstanceOf(RemoteFailedError);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});

describe("remoteFactory gates-review", () => {
  it("returns the remote's aud and gates", async () => {
    expect(await reviewing({ aud: "basement", gates: [GATE] }).gatesReview()).toEqual({ aud: "basement", gates: [GATE] });
  });

  it("reports an error envelope as a failure naming the error and status", async () => {
    const remote = remoteFactory(BASE, answering(500, { ok: false, error: "database is locked", code: 70 }));

    await expect(remote.gatesReview()).rejects.toThrow(/factory\.gates-review at http:\/\/127\.0\.0\.1:7410 failed \(HTTP 500\): database is locked/);
  });

  it("fails on a non-2xx status even when the body says ok", async () => {
    await expect(reviewing({ aud: "basement", gates: [GATE] }, 500).gatesReview()).rejects.toThrow(/answered HTTP 500/);
  });

  it("reports a gate row without batchability as an unexpected shape", async () => {
    const rowWithoutBatchable: Record<string, unknown> = { ...GATE };
    delete rowWithoutBatchable.batchable;

    await expect(reviewing({ aud: "basement", gates: [rowWithoutBatchable] }).gatesReview()).rejects.toThrow(/unexpected shape/);
  });

  it("refuses more gates than any real queue holds", async () => {
    const gates = Array.from({ length: MAX_REVIEW_GATES + 1 }, (_, n) => ({ ...GATE, gateId: `g-${n}` }));

    await expect(reviewing({ aud: "basement", gates }).gatesReview()).rejects.toThrow(/unexpected shape/);
  });

  it("refuses a list that names one gate id twice", async () => {
    await expect(reviewing({ aud: "basement", gates: [GATE, { ...GATE, runId: "run-2" }] }).gatesReview()).rejects.toThrow(/duplicate gate ids/);
  });

  it.each([
    ["a gate id", { aud: "basement", gates: [{ ...GATE, gateId: `g-1${ESC}` }] }],
    ["the aud", { aud: `basement${ESC}`, gates: [GATE] }],
    ["a repo with a bidi override", { aud: "basement", gates: [{ ...GATE, repo: "example-org/‮repo" }] }],
  ])("refuses control characters in %s", async (_where, data) => {
    await expect(reviewing(data).gatesReview()).rejects.toThrow(/control characters/);
  });

  it("refuses an error envelope carrying control characters without echoing them", async () => {
    const failure = remoteFactory(BASE, answering(500, { ok: false, error: `${ESC}all clear` })).gatesReview();

    await expect(failure).rejects.toThrow(/control characters/);
    await expect(failure).rejects.not.toThrow(ESC);
  });
});

describe("remoteFactory health", () => {
  it("returns the installed owner key ids", async () => {
    const remote = remoteFactory(BASE, answering(200, { ok: true, ownerKeys: { count: 2, ids: ["0123456789abcdef", "fedcba9876543210"] } }));

    expect(await remote.ownerKeyIds()).toEqual(["0123456789abcdef", "fedcba9876543210"]);
  });

  it("returns no owner key ids when the key ring is refused", async () => {
    const remote = remoteFactory(BASE, answering(200, { ok: true, ownerKeys: { count: 0, refusal: "/etc/titan-factory/owner-keys is missing" } }));

    expect(await remote.ownerKeyIds()).toEqual([]);
  });

  it("fails on a non-2xx status even when the body lists keys", async () => {
    const remote = remoteFactory(BASE, answering(503, { ok: true, ownerKeys: { count: 1, ids: ["0123456789abcdef"] } }));

    await expect(remote.ownerKeyIds()).rejects.toThrow(/\/health at .* answered HTTP 503/);
  });

  it("refuses a key id that is not 16 lowercase hex", async () => {
    const remote = remoteFactory(BASE, answering(200, { ok: true, ownerKeys: { count: 1, ids: [`0123456789abcdef${ESC}`] } }));

    await expect(remote.ownerKeyIds()).rejects.toThrow(/unexpected shape/);
  });
});

describe("remoteFactory proof answers", () => {
  it("returns the per-item outcomes of an applied proof", async () => {
    expect(await remoteFactory(BASE, answering(200, APPLIED)).postProof(RESOLVE_PROOF_PATH, PROOF)).toEqual({ status: 200, body: APPLIED });
  });

  it.each([
    ["an empty body", {}],
    ["no items", { ok: true, batchId: "b-1", items: [] }],
    ["an unknown outcome", { ok: true, batchId: "b-1", items: [{ gate: "g-1", outcome: "approved" }] }],
  ])("treats a 200 with %s as a failure that may have applied", async (_what, body) => {
    await expect(remoteFactory(BASE, answering(200, body)).postProof(RESOLVE_PROOF_PATH, PROOF)).rejects.toThrow(/unexpected shape.*may have applied/);
  });

  it("maps a body that is not JSON to a failure with exit 1", async () => {
    const remote = remoteFactory(BASE, answering(502, "<html>Bad Gateway</html>"));

    await expect(remote.ownerKeyIds()).rejects.toMatchObject({ exit: EXIT.FAILURE, message: expect.stringMatching(/HTTP 502/) });
    await expect(remote.postProof(RESOLVE_PROOF_PATH, PROOF)).rejects.toThrow(/not JSON.*may have applied/);
  });
});

describe("remoteFactory unavailable", () => {
  it("reports a refused connection as unavailable, naming the URL and the ssh LocalForward", async () => {
    const base = await listening(createServer());
    await new Promise((done) => servers.pop()?.close(done));

    const reading = remoteFactory(base).ownerKeyIds();

    await expect(reading).rejects.toBeInstanceOf(UnavailableError);
    await expect(reading).rejects.toMatchObject({ exit: EXIT.UNAVAILABLE, message: expect.stringContaining(`${base}/health`) });
    await expect(reading).rejects.toThrow(/ECONNREFUSED.*LocalForward/);
  });

  it("reports a remote that never answers as unavailable once the timeout passes", async () => {
    const base = await listening(createServer(() => undefined));

    await expect(remoteFactory(base, fetch, 50).gatesReview()).rejects.toThrow(/did not answer within 0\.05 s/);
  });

  it("warns that a proof whose post timed out may have applied", async () => {
    const base = await listening(createServer(() => undefined));

    const posting = remoteFactory(base, fetch, 50).postProof(RESOLVE_PROOF_PATH, PROOF);

    await expect(posting).rejects.toBeInstanceOf(UnavailableError);
    await expect(posting).rejects.toThrow(/did not answer within 0\.05 s; the proof may have applied/);
  });
});
