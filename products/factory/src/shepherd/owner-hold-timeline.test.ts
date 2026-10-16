import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { BRANCH, callCommand, shepherdFixture } from "../test-support/shepherd.js";
import type { Registered } from "./commands.js";
import type { PrTimeline } from "./view.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const OWNER = "owner-asked: discuss; TP-1";
const G10 = "g10-review: x";

async function world() {
  const fixture = shepherdFixture({ frozen: true });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  fixture.fake.addPr({ headSha: H1, headRef: BRANCH });
  const call = <T>(name: string, args: unknown) => callCommand<T>(host, fixture.routes, name, args);
  const registered = await call<Registered>("shepherd.register", { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a" });
  if (!registered.ok) throw new Error(registered.error);
  const hold = async (reason: string, reviewer?: string): Promise<void> => {
    const held = await call("shepherd.hold", { repo: REPO, pr: 1, reason, ...(reviewer && { reviewer }) });
    if (!held.ok) throw new Error(held.error);
  };
  const heldRow = async (): Promise<PrTimeline["row"]["held"]> => {
    const timeline = await call<PrTimeline>("shepherd.timeline", { repo: REPO, pr: 1 });
    if (!timeline.ok) throw new Error(timeline.error);
    return timeline.data.row.held;
  };
  return { store: fixture.routes.shepherd!.store.get(), runId: registered.data.runId, hold, heldRow };
}

// agent-chat scripts/seat/premerge reads `shepherd timeline --json | jq .row.held.reason` and refuses a merge
// when it starts with `owner-asked:`; this pins that shape for the bash consumer.
describe("premerge's owner-hold read: shepherd timeline row.held.reason", () => {
  it.each([
    ["owner first, then a g10-review hold", [OWNER, G10]],
    ["a g10-review hold first, then the owner", [G10, OWNER]],
  ])("is the owner-asked reason with %s", async (_case, order) => {
    const w = await world();
    for (const reason of order) await (reason === G10 ? w.hold(reason, "rv-sec") : w.hold(reason));

    const held = await w.heldRow();

    expect(held?.reason).toBe(OWNER);
    expect(held?.reason.startsWith("owner-asked:")).toBe(true);
  });

  it("stays the owner-asked reason, with no satisfiedAt, once the g10 reviewer's MERGE is recorded", async () => {
    const w = await world();
    await w.hold(OWNER);
    await w.hold(G10, "rv-sec");
    w.store.satisfyHold(w.runId, "rv-sec", H1, { agentId: "agent-rv-sec", sessionId: "session-rv-sec", locator: {} });

    const held = await w.heldRow();

    expect(w.store.byRun(w.runId)?.holdSatisfied?.head).toBe(H1);
    expect(held).toEqual({ reason: OWNER });
  });

  it("falls back to the g10 reason once the owner releases", async () => {
    const w = await world();
    await w.hold(OWNER);
    await w.hold(G10, "rv-sec");
    w.store.releaseOwnerHold(w.runId, { actor: "owner-terminal:test" });

    const held = await w.heldRow();

    expect(held?.reason).toBe(G10);
  });
});
