import { fakeGitHub, fakeSha, githubPort, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { SHEPHERD_MIGRATIONS } from "../workflows.js";
import type { GateConclusion } from "./gate-evidence.js";
import { heldCheck } from "./hold.js";
import { lanGatesSatisfier } from "./lan-gates.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { ShepherdStore } from "./store.js";

const REPO = "owner/demo-repo";
const H1 = fakeSha("lan-head-1");
const H2 = fakeSha("lan-head-2");
const SMOKE = "demo-smoke";
const DEVICE = "demo-device-check";
const REASON = `lan-gates: ${SMOKE}, ${DEVICE}; gates run off GitHub Actions`;

interface Rig {
  fake: FakeGitHub;
  port: GitHubPort;
  store: ShepherdStore;
  pr: number;
}

function rig(): Rig {
  const db = openDatabase(":memory:");
  runMigrations(db, SHEPHERD_MIGRATIONS);
  const store = new ShepherdStore(db, () => Date.parse("2026-10-28T12:00:00Z"));
  const fake = fakeGitHub({ repo: REPO });
  const { number: pr } = fake.addPr({ headSha: H1 });
  store.register({ repo: REPO, pr, runId: "run-1", task: "demo/T-1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  [SMOKE, DEVICE].forEach((gate) => store.gateEvidence().declare(gate));
  store.hold("run-1", REASON);
  return { fake, port: githubPort(fake.wire), store, pr };
}

const record = (r: Rig, head: string, gate: string, conclusion: GateConclusion) => r.store.gateEvidence().record({ repo: REPO, head, gate, conclusion, source: "factory:demo-build" });

/** The merge port's own hold read, with the lan-gates satisfier wired as `workflows.ts` wires it. */
const heldAt = (r: Rig, sha: string) => heldCheck(r.port, () => r.store, undefined, lanGatesSatisfier(() => r.store))(REPO, r.pr, sha);

describe("a lan-gates hold released by gate evidence", () => {
  it("stays held when every gate is green only at a head the PR has moved past", async () => {
    const r = rig();
    record(r, H1, SMOKE, "success");
    record(r, H1, DEVICE, "success");
    r.fake.pushHead(r.pr, H2);

    const held = await heldAt(r, H2);

    expect(held).toBe(REASON);
    expect(r.store.byRun("run-1")?.held).toBe(true);
  });

  it("stays held when the newest record for one gate at the head is red, even after an earlier green one", async () => {
    const r = rig();
    record(r, H1, SMOKE, "success");
    record(r, H1, DEVICE, "success");
    record(r, H1, DEVICE, "failure");

    const held = await heldAt(r, H1);

    expect(held).toBe(REASON);
  });

  it("stays held while one named gate has no record at the head", async () => {
    const r = rig();
    record(r, H1, SMOKE, "success");

    const held = await heldAt(r, H1);

    expect(held).toBe(REASON);
  });

  it("releases once every named gate is green at the PR's exact head, recording that head on the release", async () => {
    const r = rig();
    record(r, H1, SMOKE, "success");
    record(r, H1, DEVICE, "success");

    const held = await heldAt(r, H1);

    expect(held).toBeUndefined();
    expect(r.store.eventsOf("run-1").filter((event) => event.kind === "release").map((event) => [event.reason, event.actor, event.headSha])).toEqual([[REASON, "shepherd", H1]]);
  });

  it("stays held when the hold names a reviewer, whose verdict it waits for", async () => {
    const r = rig();
    r.store.hold("run-1", REASON, "rv-demo");
    record(r, H1, SMOKE, "success");
    record(r, H1, DEVICE, "success");

    const held = await heldAt(r, H1);

    expect(held).toBe(REASON);
  });
});
