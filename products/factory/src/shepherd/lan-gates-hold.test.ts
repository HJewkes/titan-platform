import { fakeSha } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { REPO } from "../test-support/land.js";
import { callCommand, shepherdFixture } from "../test-support/shepherd.js";

const H1 = fakeSha("lan-head-1");
const SMOKE = "demo-smoke";

describe("placing a lan-gates hold", () => {
  const hosts: FactoryHost[] = [];
  afterEach(() => hosts.splice(0).forEach((host) => host.close()));

  async function registeredWorld() {
    const fixture = shepherdFixture({ frozen: true });
    const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
    hosts.push(host);
    const call = (name: string, args: unknown) => callCommand(host, fixture.routes, name, args);
    fixture.fake.addPr({ headSha: H1, headRef: "agent-chat/demo-1" });
    const registered = await call("shepherd.register", { repo: REPO, pr: 1, task: "demo/T-1", implementer: "impl-a" });
    if (!registered.ok) throw new Error(registered.error);
    const store = fixture.routes.shepherd!.store.get();
    store.gateEvidence().declare(SMOKE);
    return { call, store, repo: REPO };
  }

  it("refuses with exit 65 a gate never declared, and holds nothing", async () => {
    const { call, store, repo } = await registeredWorld();

    const refused = await call("shepherd.hold", { repo, pr: 1, reason: `lan-gates: ${SMOKE}, demo-unknown-gate; demo` });

    expect(refused).toMatchObject({ ok: false, code: 65, error: expect.stringContaining("demo-unknown-gate is not a declared gate") });
    expect(store.byPr(repo, 1)?.held).toBe(false);
  });

  it.each([
    ["names no gate", "lan-gates: ; demo", "it names none"],
    ["misspells one", "lan-gates: Demo Smoke; demo", '"Demo Smoke" is not a gate name'],
  ])("refuses with exit 65 a reason that %s", async (_case, reason, why) => {
    const { call, store, repo } = await registeredWorld();

    const refused = await call("shepherd.hold", { repo, pr: 1, reason });

    expect(refused).toMatchObject({ ok: false, code: 65, error: expect.stringContaining(why) });
    expect(store.byPr(repo, 1)?.held).toBe(false);
  });

  it("holds when every gate it names is declared, with no task ID", async () => {
    const { call, store, repo } = await registeredWorld();

    const held = await call("shepherd.hold", { repo, pr: 1, reason: `lan-gates: ${SMOKE}; demo` });

    expect(held).toMatchObject({ ok: true });
    expect(store.byPr(repo, 1)?.holdReason).toBe(`lan-gates: ${SMOKE}; demo`);
  });
});
