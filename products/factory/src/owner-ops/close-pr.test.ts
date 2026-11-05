import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnerOp } from "@titan-design/owner-queue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Outcome } from "../console-action/outcome.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { callCommand, shepherdFixture, type ShepherdFixture } from "../test-support/shepherd.js";
import { closePr } from "./close-pr.js";
import { ownerOpsLedger, runLogged, type OwnerOpsLedger } from "./ledger.js";

const REPO = "example-org/example-repo";
const H = "a".repeat(40);
const H2 = "b".repeat(40);
const CONFIRM = `action:${"d".repeat(64)}`;
const NOW = () => Date.parse("2026-10-18T12:00:00.000Z");

const hosts: FactoryHost[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

interface World {
  fixture: ShepherdFixture;
  host: FactoryHost;
  ledger: OwnerOpsLedger;
  pr: number;
  op: OwnerOp;
  /** One tap as the route runs it: inside `runLogged`, so the ledger sees `started` before the effect. */
  tap(): Promise<Outcome>;
  closes(): number;
}

function world(): World {
  const fixture = shepherdFixture();
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  const dir = mkdtempSync(join(tmpdir(), "factory-close-pr-"));
  dirs.push(dir);
  const ledger = ownerOpsLedger(dir);
  const { number: pr, headRef } = fixture.fake.addPr({ headSha: H });
  fixture.fake.refs.set(headRef, H);
  const op: OwnerOp = { kind: "close-pr", repo: REPO, pr, headSha: H };
  const services = fixture.routes.shepherd!;
  const deps = { host, port: services.port, services, ledger };
  return {
    fixture,
    host,
    ledger,
    pr,
    op,
    tap: () => runLogged(ledger, { actionId: "act-1", op, now: NOW }, () => closePr("act-1", { op, confirmEvent: CONFIRM }, deps)),
    closes: () => fixture.fake.calls.filter((call) => call === "closePr").length,
  };
}

async function register(w: World): Promise<string> {
  const registered = await callCommand<{ runId: string }>(w.host, w.fixture.routes, "shepherd.register", { repo: REPO, pr: w.pr, task: "demo/T-1", implementer: "impl-a" });
  if (!registered.ok) throw new Error(registered.error);
  return registered.data.runId;
}

describe("close-pr", () => {
  it("closes a PR open at the confirmed head, keeps its branch, and logs done with the closed head", async () => {
    const w = world();

    const outcome = await w.tap();

    expect(outcome).toEqual({ outcome: "pr-closed", closedHead: H });
    expect(w.fixture.fake.pr(w.pr).state).toBe("closed");
    expect(w.fixture.fake.refs.get(w.fixture.fake.pr(w.pr).headRef)).toBe(H);
    expect(w.fixture.fake.effects.deleteRef).toBe(0);
    expect((await w.ledger.read("act-1")).map((entry) => entry.phase)).toEqual(["started", "done"]);
  });

  it("answers moved and closes nothing when the PR is open at another head", async () => {
    const w = world();
    w.fixture.fake.pushHead(w.pr, H2);

    const outcome = await w.tap();

    expect(outcome).toEqual({ outcome: "moved", currentHead: H2 });
    expect(w.fixture.fake.pr(w.pr).state).toBe("open");
    expect(w.closes()).toBe(0);
  });

  it("answers gone for a PR closed elsewhere with no ledger row for this record", async () => {
    const w = world();
    await w.fixture.fake.wire.closePr(REPO, w.pr);

    const outcome = await w.tap();

    expect(outcome).toEqual({ outcome: "gone", reason: `${REPO}#${w.pr} is closed elsewhere on GitHub` });
  });

  it("answers already on a replay after done, and closes only once", async () => {
    const w = world();
    await w.tap();

    const replay = await w.tap();

    expect(replay).toEqual({ outcome: "already", closedHead: H });
    expect(w.closes()).toBe(1);
  });

  it("finishes a started row with no done whose close landed: already, and the Shepherd run it skipped ends", async () => {
    const w = world();
    const runId = await register(w);
    await w.ledger.append({ at: new Date(NOW()).toISOString(), actionId: "act-1", phase: "started", kind: "close-pr", target: { repo: REPO, pr: w.pr, headSha: H } });
    await w.fixture.fake.wire.closePr(REPO, w.pr);

    const outcome = await w.tap();

    expect(outcome).toEqual({ outcome: "already", closedHead: H });
    await vi.waitFor(() => expect(w.host.runtime.status(runId)?.status).toBe("cancelled"));
  });

  it("closes a PR still open at the confirmed head after a started row with no done", async () => {
    const w = world();
    await w.ledger.append({ at: new Date(NOW()).toISOString(), actionId: "act-1", phase: "started", kind: "close-pr", target: { repo: REPO, pr: w.pr, headSha: H } });

    const outcome = await w.tap();

    expect(outcome).toEqual({ outcome: "pr-closed", closedHead: H });
    expect(w.closes()).toBe(1);
  });

  it("ends the PR's live Shepherd run after the close", async () => {
    const w = world();
    const runId = await register(w);

    await w.tap();

    await vi.waitFor(() => expect(w.host.runtime.status(runId)?.status).toBe("cancelled"));
  });
});
