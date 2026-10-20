import { describe, expect, it } from "vitest";
import { appliedVersions, openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { openFactoryHost, factoryMigrations } from "../../host.js";
import type { CiFact } from "./ci-shapes.js";
import { openFeed } from "./feed.js";
import { a17Event, registerA17 } from "./register.js";

const HEAD = "a".repeat(40);
const status = (over: Partial<CiFact> = {}): CiFact => ({ type: "status", repo: "o/r", head: HEAD, context: "ci", outcome: "success", at: "2026-10-17T10:00:00Z", ...over });

const ran: string[] = [];
describe("nested registration", () => {
  a17Event("runs under a nested describe", () => {
    ran.push(expect.getState().currentTestName ?? "");
  });
});

describe("a17Event", () => {
  it("registers one case per mode, each titled with its suffix", () => {
    const names: string[] = [];

    registerA17("x", () => undefined, (name) => names.push(name));

    expect(names).toEqual(["A17: x [webhook]", "A17: x [polling]"]);
  });

  it("runs both modes' bodies from a nested describe, each with its own feed", () => {
    expect(ran.sort()).toEqual(["nested registration > A17: runs under a nested describe [polling]", "nested registration > A17: runs under a nested describe [webhook]"]);
  });
});

describe("feed shape", () => {
  it("gives a delivery then a backstop re-observation in webhook, one observation in polling", () => {
    expect(openFeed("webhook").fact(status())).toEqual(["inserted", "occurrence"]);
    expect(openFeed("polling").fact(status())).toEqual(["inserted"]);
  });

  it("delivers a transient fact in webhook only", () => {
    const webhook = openFeed("webhook");
    const polling = openFeed("polling");

    webhook.transient(status({ outcome: "failure" }));
    polling.transient(status({ outcome: "failure" }));

    expect([webhook.headSeq(), polling.headSeq()]).toEqual([1, 0]);
  });

  it("advances the fake clock by the mode's interval by default", () => {
    const webhook = openFeed("webhook");
    const polling = openFeed("polling");
    const [w0, p0] = [webhook.now(), polling.now()];

    webhook.advance();
    polling.advance();

    expect(webhook.now() - w0).toBeGreaterThan(polling.now() - p0);
  });
});

describe("factoryMigrations", () => {
  it("applies the same versions as a host opened on the same database", () => {
    const captured: Db[] = [];
    const routes = Object.assign([], { database: { extraMigrations: [], bind: (db: Db) => (captured.push(db), () => undefined) } });
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [], routes });
    const hostVersions = appliedVersions(captured[0]!);
    host.close();
    const db = openDatabase(":memory:");
    runMigrations(db, factoryMigrations());

    expect(appliedVersions(db)).toEqual(hostVersions);
    expect(hostVersions).toEqual(expect.arrayContaining([29, 30]));
  });
});
