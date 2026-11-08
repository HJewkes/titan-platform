import { fakeGitHub, githubPort } from "@titan-design/github";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { defineWorkflow } from "../definition.js";
import { openFactoryHost } from "../host.js";
import { factoryRoutesFor } from "../workflows.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { sweepSeatDigests, type SeatState } from "./seat-digest.js";
import { shepherdStoreRef } from "./store.js";

const SEAT = "widgets-coord";
const REPO = "acme/widgets";
const TIMEOUT = `gh api -X GET repos/${REPO}/compare/main...abc?per_page=1 failed (1): GET /repos/${REPO}/compare/main...abc?per_page=1 timed out after 60000 ms`;

/** A stand-in for shepherd-pr: a run started with `fail` fails with a read timeout, any other one completes. */
const shepherdStandIn = defineWorkflow({
  name: "shepherd-pr",
  steps: [],
  run: async (ctx) => {
    if (ctx.param("fail")) throw new Error(TIMEOUT);
  },
});

function world() {
  const store = shepherdStoreRef();
  const fake = fakeGitHub();
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => 0, sleep: async () => undefined });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdStandIn], routes, gatePollMs: 5 });
  onTestFinished(() => host.close());
  const states = new Map<string, SeatState>([[SEAT, { open: [], finished: [], at: "2026-10-10T00:00:00.000Z" }]]);
  const sent: string[] = [];
  const sweep = () => sweepSeatDigests(host, { store, port: githubPort(fake.wire), seats: () => ({ seats: [], denied: [] }) }, {
    seatLookup: () => () => SEAT,
    send: async (_seat, text) => void sent.push(text),
  }, { get: (seat) => states.get(seat), set: (seat, state) => void states.set(seat, state) });
  return { host, store, sent, sweep };
}

describe("seat digest superseded failures", () => {
  it("tells a failed run that was re-registered over before any digest read it", async () => {
    const { host, store, sent, sweep } = world();
    const failed = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", fail: "yes" });
    store.get().register({ repo: REPO, pr: 1, runId: failed, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    await vi.waitFor(() => expect(host.runtime.status(failed)?.status).toBe("failed"));
    const restarted = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1" });
    store.get().repoint(failed, restarted);

    await sweep();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`Failed:\n- ${REPO}#1 failed at `);
    expect(sent[0]).toContain(TIMEOUT);
  });

  it("tells a superseded failure once", async () => {
    const { host, store, sent, sweep } = world();
    const failed = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", fail: "yes" });
    store.get().register({ repo: REPO, pr: 1, runId: failed, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    await vi.waitFor(() => expect(host.runtime.status(failed)?.status).toBe("failed"));
    store.get().repoint(failed, host.runtime.start("shepherd-pr", { repo: REPO, pr: "1" }));
    await sweep();

    await sweep();

    expect(sent.filter((text) => text.includes("Failed:"))).toHaveLength(1);
  });
});
