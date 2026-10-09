import { listTools } from "@titan-design/daemon";
import { fakeGitHub, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { EXIT, invokeCommand } from "@titan-design/registry";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { createFactoryRegistry, parsePrRef, type FactoryContext } from "./registry.js";
import { TOOL_PREFIX } from "./serve.js";
import { H1, REPO, gateId, gateOpened } from "./test-support/land.js";
import { landPrRoutes, landPrWorkflow } from "./workflows/land-pr.js";
import { OWNER } from "./test-support/resolver.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** PR #1 on a fake repo whose checks pass, and a host running the registered land-pr workflow. */
function world(): { host: FactoryHost; fake: FakeGitHub } {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  let clock = 0;
  const routes = landPrRoutes({ port: githubPort(fake.wire), now: () => clock, sleep: async (ms) => void (clock += ms) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [landPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake };
}

async function call(host: FactoryHost, name: string, args: unknown): Promise<{ ok: boolean; data?: unknown; code?: number }> {
  const registry = createFactoryRegistry();
  const ctx: FactoryContext = { warnings: [], format: "json", host };
  const { envelope } = await invokeCommand(registry.get(name)!, args, ctx);
  return envelope;
}

function landRuns(host: FactoryHost): string[] {
  return host.runtime.list(["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"]).filter((run) => run.workflowName === "land-pr").map((run) => run.id);
}

describe("factory registry", () => {
  it("surfaces the factory, shepherd and needs commands as MCP tools, with no prefix doubling and no resolve tool", () => {
    const tools = listTools({ registry: createFactoryRegistry(), createContext: () => ({ warnings: [], format: "json" }) as never, toolPrefix: TOOL_PREFIX, name: "titan-factory", version: "0" });

    const shepherd = ["hold", "list", "merge", "register", "release", "resync", "status", "timeline", "waiting"].map((verb) => `shepherd__${verb}`);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["factory__gates", "factory__land", "factory__status", "needs__count", "needs__list", ...shepherd]);
  });

  it("a second land on the same PR returns the unfinished run instead of starting another", async () => {
    const { host } = world();

    const first = await call(host, "factory.land", { repo: REPO, pr: 1, task: "demo/T-1" });
    const second = await call(host, "factory.land", { repo: REPO, pr: 1 });

    expect(first).toMatchObject({ ok: true, data: { created: true } });
    expect(second).toMatchObject({ ok: true, data: { created: false, runId: (first.data as { runId: string }).runId } });
    expect(landRuns(host)).toHaveLength(1);
    expect(host.runtime.status((first.data as { runId: string }).runId)?.params).toMatchObject({ repo: REPO, pr: "1", task: "demo/T-1" });
  });

  it("starts a fresh run once the earlier run for the PR has finished", async () => {
    const { host } = world();
    const first = (await call(host, "factory.land", { repo: REPO, pr: 1 })).data as { runId: string };
    await gateOpened(host, gateId(first.runId, "approve-merge"));
    host.runtime.signal(first.runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    await host.runtime.wait(first.runId);

    const again = await call(host, "factory.land", { repo: REPO, pr: 1 });

    expect(host.runtime.status(first.runId)?.status).toBe("completed");
    expect(again).toMatchObject({ ok: true, data: { created: true } });
    expect(landRuns(host)).toHaveLength(2);
  });

  it("refuses a repo that is not exactly owner/repo before starting anything", async () => {
    const { host } = world();

    const result = await call(host, "factory.land", { repo: "octo/../demo", pr: 1 });

    expect(result).toMatchObject({ ok: false, code: EXIT.DATAERR });
    expect(landRuns(host)).toEqual([]);
  });

  it("lists a pending gate with the local CLI command that resolves it, and reports the run", async () => {
    const { host } = world();
    const { runId } = (await call(host, "factory.land", { repo: REPO, pr: 1 })).data as { runId: string };
    await gateOpened(host, gateId(runId, "approve-merge"));

    const gates = await call(host, "factory.gates", {});
    const status = await call(host, "factory.status", { runId });

    expect(gates).toMatchObject({ ok: true, data: { gates: [{ runId, stepId: "approve-merge", resolve: `titan-factory gate resolve ${runId} approve-merge --json '<payload>'` }] } });
    expect(status).toMatchObject({ ok: true, data: { runs: [{ id: runId, status: "paused", params: { repo: REPO, pr: "1" } }] } });
    expect(await call(host, "factory.status", { runId: "missing" })).toMatchObject({ ok: false, code: EXIT.NOINPUT });
  });
});

describe("owner/repo#N parsing", () => {
  it.each([
    ["octo/demo#12", { repo: "octo/demo", pr: 12 }],
    ["octo-org/demo.js_v2#3", { repo: "octo-org/demo.js_v2", pr: 3 }],
  ])("accepts %s", (ref, expected) => {
    expect(parsePrRef(ref)).toEqual(expected);
  });

  it.each([
    ["no #", "octo/demo"],
    ["an empty number", "octo/demo#"],
    ["a non-integer", "octo/demo#1.5"],
    ["a word", "octo/demo#abc"],
    ["zero", "octo/demo#0"],
    ["a leading zero", "octo/demo#01"],
    ["a negative number", "octo/demo#-1"],
    ["a second #", "octo/demo#1#2"],
    ["a missing repo", "octo#1"],
    ["an extra path segment", "octo/demo/extra#1"],
    ["a .. repo", "octo/..#1"],
    ["a .. owner", "../demo#1"],
    ["a .. inside the name", "octo/de..mo#1"],
    ["surrounding space", " octo/demo#1"],
    ["an unsafe integer", "octo/demo#99999999999999999999"],
  ])("refuses %s", (_why, ref) => {
    expect(() => parsePrRef(ref)).toThrow(/expected owner\/repo#N/);
  });
});
