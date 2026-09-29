import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, githubPort, successRun } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { H1, REPO, gateId, gateOpened } from "./test-support/land.js";
import { configuredRoutes } from "./workflows.js";
import { landPrWorkflow } from "./workflows/land-pr.js";
import { NO_COMMAND, type ChoreExec } from "./workflows/post-merge.js";

const hosts: FactoryHost[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function configHome(config: object | undefined): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), "factory-routes-"));
  dirs.push(home);
  if (config) {
    mkdirSync(join(home, "titan-factory"));
    writeFileSync(join(home, "titan-factory", "config.json"), JSON.stringify(config));
  }
  return { XDG_CONFIG_HOME: home };
}

async function landWith(env: NodeJS.ProcessEnv): Promise<{ argvs: (readonly string[])[]; record: unknown }> {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const argvs: (readonly string[])[] = [];
  const runChore: ChoreExec = async (argv) => {
    argvs.push(argv);
    return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
  };
  let clock = 0;
  const routes = configuredRoutes(env, { port: githubPort(fake.wire), now: () => clock, sleep: async (ms) => void (clock += ms), runChore });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [landPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("land-pr", { repo: REPO, pr: "1" });
  await gateOpened(host, gateId(runId, "approve-merge"));
  host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 });
  await host.runtime.wait(runId);
  const record = Object.values(host.runtime.status(runId)!.stepResults).find((result) => result.stepId === "post-merge")?.data;
  return { argvs, record };
}

describe("configuredRoutes", () => {
  it("runs the postMerge argv from the config file after a merge through the real route set", async () => {
    const { argvs, record } = await landWith(configHome({ postMerge: { argv: ["chore", "--prune"] } }));

    expect(argvs).toEqual([["chore", "--prune"]]);
    expect(record).toMatchObject({ result: { exitCode: 0 } });
  });

  it("records skipped and runs nothing when the config has no postMerge key", async () => {
    const { argvs, record } = await landWith(configHome({}));

    expect(argvs).toEqual([]);
    expect(record).toMatchObject({ result: { skipped: NO_COMMAND } });
  });

  it("records skipped when there is no config file", async () => {
    const { argvs, record } = await landWith(configHome(undefined));

    expect(argvs).toEqual([]);
    expect(record).toMatchObject({ result: { skipped: NO_COMMAND } });
  });
});
