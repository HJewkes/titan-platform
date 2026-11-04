import { fakeGitHub, fakeSha, githubPort, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { deadEndParam, deadEndRoutes, deadEndWorkflow } from "../test-support/dead-end.js";
import { gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { abandonCloseRoute } from "./abandon-close.js";

const REPO = "o/r";
const TASK = "demo/TP-1";
const [H1, H2] = [fakeSha("abandon-1"), fakeSha("abandon-2")];
const CLOSE = ["agent-chat", "gh-write", "--", "pr", "close", "1", "--repo", REPO];
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface World {
  host: FactoryHost;
  runId: string;
  fake: FakeGitHub;
  commands: string[][];
  reopened: string[];
  notes: string[];
}

/** A fake runner that plays `gh-write -- pr close` on the GitHub fake, deleting the head ref only when told to. */
function ghWriteOn(fake: FakeGitHub, commands: string[][]) {
  return async (file: string, args: readonly string[]) => {
    commands.push([file, ...args]);
    const pull = fake.pr(Number(args[4]));
    pull.state = "closed";
    if (args.includes("--delete-branch")) fake.refs.delete(pull.headRef);
    return { code: 0, stdout: "", stderr: "" };
  };
}

async function pausedAtH1(advisory = false): Promise<World> {
  const fake = fakeGitHub();
  const pull = fake.addPr({ headSha: H1 });
  fake.refs.set(pull.headRef, H1);
  const [commands, reopened, notes]: [string[][], string[], string[]] = [[], [], []];
  const tasks = { reopen: async (initiative: string, id: string) => void reopened.push(`${initiative}/${id}`), appendNote: async (_: string, __: string, line: string) => void notes.push(line) };
  const abandon = abandonCloseRoute(() => 0, { port: githubPort(fake.wire), agentChatBin: "agent-chat", run: ghWriteOn(fake, commands), task: () => TASK, tasks, advisory: () => advisory });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [deadEndWorkflow], routes: deadEndRoutes(undefined, abandon), gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", deadEnd: deadEndParam([H1, H2]) });
  await gateOpened(host, gateId(runId, "sh-dead-end"));
  return { host, runId, fake, commands, reopened, notes };
}

const abandonAtH1 = (world: World): void => void world.host.gates.resolve(gateId(world.runId, "sh-dead-end"), { decision: "abandon", headSha: H1 }, OWNER);

async function stopped(world: World): Promise<unknown> {
  await vi.waitFor(() => expect(world.host.runtime.status(world.runId)?.status).toBe("completed"));
  return Object.values(world.host.runtime.status(world.runId)!.stepResults).find((result) => result.stepId.startsWith("sh-stopped"))?.data;
}

describe("abandon on a dead-end gate", () => {
  it("abandon runs `agent-chat gh-write -- pr close <n> --repo <r>` with no --delete-branch, leaves the branch ref, reopens the task with a note, and stops the run as abandoned", async () => {
    const world = await pausedAtH1();

    abandonAtH1(world);

    expect(await stopped(world)).toMatchObject({ result: { kind: "stopped", reason: "abandoned", headSha: H1 } });
    expect(world.commands).toEqual([CLOSE]);
    expect(world.fake.pr(1).state).toBe("closed");
    expect(world.fake.refs.get(world.fake.pr(1).headRef)).toBe(H1);
    expect(world.reopened).toEqual([TASK]);
    expect(world.notes).toEqual([`reopened by Shepherd: ${REPO}#1 closed at ${H1} on a dead-end abandon`]);
  });

  it("abandon at a head the PR moved past closes nothing and re-asks", async () => {
    const world = await pausedAtH1();
    world.fake.pushHead(1, H2);

    abandonAtH1(world);

    await gateOpened(world.host, gateId(world.runId, "sh-dead-end", 1));
    expect(world.host.gates.get(gateId(world.runId, "sh-dead-end", 1))?.prompt).toContain(`at head ${H2}`);
    expect(world.commands).toEqual([]);
    expect(world.fake.pr(1).state).toBe("open");
    expect(world.reopened).toEqual([]);
  });

  it("abandon on an advisory repo runs no command, leaves the PR open and the task as it is, and only stops the run", async () => {
    const world = await pausedAtH1(true);

    abandonAtH1(world);

    expect(await stopped(world)).toMatchObject({ result: { kind: "stopped", reason: "abandoned", detail: expect.stringContaining("PR advisory, task no-task") } });
    expect(world.commands).toEqual([]);
    expect(world.fake.pr(1).state).toBe("open");
    expect(world.reopened).toEqual([]);
  });

  it("a replayed sh-abandon does not close twice", async () => {
    const world = await pausedAtH1();
    world.fake.pr(1).state = "closed";

    abandonAtH1(world);

    expect(await stopped(world)).toMatchObject({ result: { kind: "stopped", reason: "abandoned", detail: expect.stringContaining("PR already-closed, task reopened") } });
    expect(world.commands).toEqual([]);
    expect(world.reopened).toEqual([TASK]);
  });
});
