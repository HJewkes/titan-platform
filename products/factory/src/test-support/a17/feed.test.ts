import { describe, expect, it } from "vitest";
import type { CiFact } from "./ci-shapes.js";
import { openFeed, type Feed } from "./feed.js";

const HEAD = "a".repeat(40);
const status = (over: Partial<CiFact> = {}): CiFact => ({ type: "status", repo: "o/r", head: HEAD, context: "ci", outcome: "success", at: "2026-10-17T10:00:00Z", ...over });

const ciSources = (feed: Feed): string[] => feed.db.prepare<[], { source: string }>("SELECT source FROM factory_event WHERE kind = 'CIConcluded' ORDER BY seq").all().map((row) => row.source);

describe("the A17 feeds go through production entry points (TP-3102 H4)", () => {
  it("under polling, a signed delivery to the ingress answers 404 and writes no webhook row", async () => {
    const feed = await openFeed("polling");

    const answer = await feed.post(status());
    await feed.fact(status({ context: "lint" }));

    expect(answer).toEqual({ status: 404, body: { error: "ingress off" } });
    expect(ciSources(feed)).toEqual(["backstop"]);
  });

  it("under webhook, a delivery then the backstop tick give one row, and a delivery with a bad signature writes nothing", async () => {
    const feed = await openFeed("webhook");

    const steps = await feed.fact(status());
    const forged = await feed.post(status({ outcome: "failure" }), { secret: "not-the-webhook-secret" });

    expect(steps).toEqual(["inserted", "occurrence"]);
    expect(forged.status).toBe(401);
    expect(ciSources(feed)).toEqual(["webhook"]);
  });

  it("runs a polling reconciler pass on the 15 s due-check once pollingIntervalMs has passed, not before", async () => {
    const feed = await openFeed("polling", { github: { pollingIntervalMs: 60_000, backstopIntervalMs: 300_000 } });
    const atStart = feed.passes();

    await feed.advance(59_000);
    const before = feed.passes();
    await feed.advance(1_000);

    expect([atStart, before, feed.passes()]).toEqual([1, 1, 2]);
  });

  it("runs a webhook backstop pass at backstopIntervalMs", async () => {
    const feed = await openFeed("webhook", { github: { pollingIntervalMs: 60_000, backstopIntervalMs: 300_000 } });

    await feed.advance(299_000);
    const before = feed.passes();
    await feed.advance(1_000);

    expect([before, feed.passes()]).toEqual([1, 2]);
  });
});
