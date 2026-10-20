import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TokenFileError, silentLogger } from "@titan-design/daemon";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { eventLogMigration } from "../event-log/event-log.js";
import { resolveSources } from "../github-sources/mode.js";
import { answerDelivery, type IngressDeps, type IngressRequest, type Projector } from "./answer.js";
import { MAX_INGRESS_BODY_BYTES } from "./paths.js";
import { signDelivery } from "./signature.js";

const SECRET = "synthetic-test-secret";
const GUID = "72d3162e-cc78-11e3-81ab-4c9367dc0958";
const SHA = "c".repeat(40);
const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const ON = () => resolveSources({ github: { sources: "webhook", ingress: "on" } });

const project: Projector = (event) =>
  event === "status"
    ? { rule: "identity", kind: "CIConcluded", repo: "o/r", subject: `o/r@${SHA}`, keys: { context: "build" }, occurrenceKey: `v1|CIConcluded|o/r|status|${SHA}|build|success`, payload: { projected: true } }
    : "ignored";

function memoryDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [eventLogMigration()]);
  return db;
}

function deps(overrides: Partial<IngressDeps> = {}): IngressDeps {
  return { sources: ON, secret: () => SECRET, project, db: memoryDb(), now: () => NOW, log: silentLogger, ...overrides };
}

function delivery(overrides: Partial<IngressRequest> = {}, event = "status", payload: unknown = { state: "success", marker: "raw-only" }): IngressRequest {
  const body = Buffer.from(JSON.stringify(payload));
  const headers = { "Content-Type": "application/json", "X-GitHub-Event": event, "X-GitHub-Delivery": GUID, "X-Hub-Signature-256": signDelivery(SECRET, body) };
  return { method: "POST", path: "/ingress/github", headers, body, ...overrides };
}

const rows = (db: Db) => db.prepare<[], { delivery_id: string; source: string; payload: string }>("SELECT delivery_id, source, payload FROM factory_event").all();

describe("answerDelivery kill switch", () => {
  // Mutation killed: the effective-mode check moved after the HMAC step, so the secret spy is called.
  it.each([{}, { sources: "polling" as const }, { sources: "webhook" as const, ingress: "off" as const }])("answers 404 under %j without reading the body or the secret", async (github) => {
    const secret = vi.fn(() => SECRET);
    const body = vi.fn(() => Promise.resolve(Buffer.from("{}")));
    const context = deps({ sources: () => resolveSources({ github }), secret });

    const signed = await answerDelivery(delivery(), context);
    const lazy = await answerDelivery(delivery({ body }), context);

    expect(signed).toEqual({ status: 404, body: { error: "ingress off" } });
    expect(lazy.status).toBe(404);
    expect(secret).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
    expect(rows(context.db)).toEqual([]);
  });
});

describe("answerDelivery storage", () => {
  // Mutation killed: the bare GUID stored with no `webhook:` prefix.
  it("stores one row keyed webhook:<guid> and answers a redelivery 200 by delivery", async () => {
    const context = deps();

    const first = await answerDelivery(delivery(), context);
    const again = await answerDelivery(delivery(), context);

    expect(first).toEqual({ status: 200, body: { seq: 1, inserted: true } });
    expect(again).toEqual({ status: 200, body: { seq: 1, by: "delivery" } });
    expect(rows(context.db).map((row) => [row.delivery_id, row.source])).toEqual([[`webhook:${GUID}`, "webhook"]]);
  });

  // Mutation killed: the parsed body passed as the row's payload instead of the projection.
  it("stores the projector's payload and nothing only the raw body carries", async () => {
    const context = deps();

    await answerDelivery(delivery(), context);

    const [row] = rows(context.db);
    expect(JSON.parse(row?.payload ?? "null")).toEqual({ projected: true });
    expect(row?.payload).not.toContain("raw-only");
  });

  // Mutation killed: a refused secret treated as an empty key, which answers 401 instead of 503.
  it("answers 503 when the secret file is refused, naming no path", async () => {
    const context = deps({
      secret: () => {
        throw new TokenFileError("mode", "/synthetic/titan-factory/secrets/github-webhook.token", "group or other can read it");
      },
    });

    const answer = await answerDelivery(delivery(), context);

    expect(answer).toEqual({ status: 503, body: { error: "webhook secret unavailable" } });
    expect(JSON.stringify(answer)).not.toMatch(/synthetic|\.token/);
    expect(rows(context.db)).toEqual([]);
  });
});

describe("answerDelivery under lock contention", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // Mutation killed: the append error caught and answered 200.
  it("answers 503 within 6 s and writes nothing while another connection holds the write lock", async () => {
    dir = mkdtempSync(join(tmpdir(), "ingress-busy-"));
    const path = join(dir, "factory.db");
    const db = openDatabase(path);
    runMigrations(db, [eventLogMigration()]);
    const holder = openDatabase(path);
    holder.exec("BEGIN IMMEDIATE");
    const started = Date.now();

    const answer = await answerDelivery(delivery(), deps({ db }));

    const elapsed = Date.now() - started;
    holder.exec("ROLLBACK");
    holder.close();
    expect(answer).toEqual({ status: 503, body: { error: "event log unavailable" } });
    expect(elapsed).toBeLessThan(6_000);
    expect(rows(db)).toEqual([]);
    db.close();
  }, 15_000);
});

describe("answerDelivery refusals", () => {
  const unsigned = (request: IngressRequest): IngressRequest => ({ ...request, headers: { ...request.headers, "X-Hub-Signature-256": signDelivery("other-secret", Buffer.from("{}")) } });
  const cases: [string, IngressRequest, number][] = [
    ["a sub-path", delivery({ path: "/ingress/github/x" }), 404],
    ["a GET", delivery({ method: "GET" }), 405],
    ["a form body", delivery({ headers: { ...delivery().headers, "Content-Type": "application/x-www-form-urlencoded" } }), 415],
    ["a non-GUID delivery id", delivery({ headers: { ...delivery().headers, "X-GitHub-Delivery": "1234" } }), 400],
    ["a missing signature", delivery({ headers: { ...delivery().headers, "X-Hub-Signature-256": "" } }), 400],
    ["a body over the cap", delivery({ body: new Uint8Array(MAX_INGRESS_BODY_BYTES + 1) }), 413],
    ["a wrong signature", unsigned(delivery()), 401],
  ];

  it.each(cases)("refuses %s with %i and writes nothing", async (_name, request, status) => {
    const context = deps();

    const answer = await answerDelivery(request, context);

    expect(answer.status).toBe(status);
    expect(rows(context.db)).toEqual([]);
  });

  it("refuses an oversized body before reading the secret and closes the connection", async () => {
    const secret = vi.fn(() => SECRET);

    const answer = await answerDelivery(delivery({ body: () => Promise.resolve("too-large" as const) }), deps({ secret }));

    expect(answer.status).toBe(413);
    expect(answer.headers).toEqual({ connection: "close" });
    expect(secret).not.toHaveBeenCalled();
  });

  it("refuses a signed body that is not JSON with 400", async () => {
    const body = Buffer.from("not json");
    const request = delivery({ body, headers: { ...delivery().headers, "X-Hub-Signature-256": signDelivery(SECRET, body) } });

    expect((await answerDelivery(request, deps())).status).toBe(400);
  });
});

describe("answerDelivery outcomes that store nothing", () => {
  it("answers a ping 200 and an unprojected event 202", async () => {
    const context = deps();

    expect(await answerDelivery(delivery({}, "ping", { zen: "synthetic" }), context)).toEqual({ status: 200, body: { ok: true, ping: true } });
    expect(await answerDelivery(delivery({}, "issues", { action: "opened" }), context)).toEqual({ status: 202, body: { ignored: true } });
    expect(rows(context.db)).toEqual([]);
  });

  it("answers 422 when a known kind fails to project", async () => {
    const context = deps({
      project: () => {
        throw new Error("synthetic projection failure");
      },
    });

    expect((await answerDelivery(delivery(), context)).status).toBe(422);
    expect(rows(context.db)).toEqual([]);
  });
});
