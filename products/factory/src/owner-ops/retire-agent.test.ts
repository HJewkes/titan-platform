import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OwnerOp } from "@titan-design/owner-queue";
import type { Outcome } from "../console-action/outcome.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { callCommand, shepherdFixture } from "../test-support/shepherd.js";
import { doneResults, ownerOpsLedger, runLogged } from "./ledger.js";
import { agentChatRetirePort, retireAgent, type RetireAgentDeps } from "./retire-agent.js";

const REPO = "example-org/example-repo";
const NAME = "item-42";
const AGENT_ID = "9e3faa6c";
const CONFIRM = `action:${"d".repeat(64)}`;

const hosts: FactoryHost[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

/**
 * A fake `agent-chat` behind the real agent-dispatch exec path: `agent ls --json` prints roster.json, and `agent retire`
 * records its argv and caller, then refuses with refuse.txt on stdout, reports the broker down, or retires.
 */
const FAKE = `#!/bin/sh
dir="$(dirname "$0")"
if [ "$2" = "ls" ]; then cat "$dir/roster.json"; exit 0; fi
printf '%s\\n' "$@" >"$dir/retire-argv"
printf '%s\\n' "\${AGENT_CHAT_NAME-unset}" >"$dir/retire-caller"
if [ -f "$dir/down" ]; then echo "could not reach or start the agent-chat broker" >&2; exit 1; fi
if [ -f "$dir/refuse.txt" ]; then cat "$dir/refuse.txt"; exit 1; fi
echo "Retired $3."
echo "the process had already exited"
`;

const row = (over: Record<string, unknown> = {}) => ({
  name: NAME, agentId: AGENT_ID, state: "exited", presence: "exited", status: "finished", profile: "headless-implementer",
  surface: "headless", cwd: "/work/tree", sessionId: "s-1", generation: 1, spawnedBy: "coordinator", ...over,
});

interface World {
  dir: string;
  host: FactoryHost;
  deps: RetireAgentDeps;
  setRoster(rows: Record<string, unknown>[]): void;
  tap(op?: Partial<Extract<OwnerOp, { kind: "retire-agent" }>>): Promise<Outcome>;
  retireCalls(): string[] | undefined;
  registerLive(implementer: string): Promise<string>;
}

function world(): World {
  const dir = mkdtempSync(join(tmpdir(), "factory-retire-agent-"));
  dirs.push(dir);
  writeFileSync(join(dir, "agent-chat.staging"), FAKE);
  chmodSync(join(dir, "agent-chat.staging"), 0o755);
  cpSync(join(dir, "agent-chat.staging"), join(dir, "agent-chat"), { preserveTimestamps: true });
  chmodSync(join(dir, "agent-chat"), 0o755);
  const fixture = shepherdFixture({ frozen: true });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  const ledger = ownerOpsLedger(dir);
  const deps: RetireAgentDeps = { host, services: fixture.routes.shepherd!, agentChat: agentChatRetirePort(join(dir, "agent-chat"), 10_000), done: (id) => doneResults(dir, id) };
  const setRoster = (rows: Record<string, unknown>[]) => writeFileSync(join(dir, "roster.json"), JSON.stringify(rows));
  setRoster([row()]);
  return {
    dir,
    host,
    deps,
    setRoster,
    tap: (over = {}) => {
      const op: OwnerOp = { kind: "retire-agent", name: NAME, agentId: AGENT_ID, force: false, ...over };
      return runLogged(ledger, { actionId: "act-1", op, now: () => 0 }, () => retireAgent("act-1", { op, confirmEvent: CONFIRM }, deps));
    },
    retireCalls: () => (existsSync(join(dir, "retire-argv")) ? readFileSync(join(dir, "retire-argv"), "utf8").trim().split("\n") : undefined),
    registerLive: async (implementer) => {
      const { number: pr } = fixture.fake.addPr({ headSha: "a".repeat(40) });
      const registered = await callCommand<{ runId: string }>(host, fixture.routes, "shepherd.register", { repo: REPO, pr, task: "demo/T-1", implementer });
      if (!registered.ok) throw new Error(JSON.stringify(registered));
      return registered.data.runId;
    },
  };
}

describe("retire-agent", () => {
  // Kills: dropping the caller, so agent_retired reads `human` instead of the console.
  it("retires an exited agent through agent-chat as titan-console and answers retired with the broker's caveats", async () => {
    const w = world();

    const outcome = await w.tap();

    expect(outcome).toEqual({ outcome: "retired", name: NAME, caveats: ["the process had already exited"] });
    expect(w.retireCalls()).toEqual(["agent", "retire", NAME]);
    expect(readFileSync(join(w.dir, "retire-caller"), "utf8").trim()).toBe("titan-console");
  });

  // Kills: answering `already` for a retire this record never made.
  it("answers already on a replay of the record that retired, and gone for a record that did not", async () => {
    const w = world();
    await w.tap();
    w.setRoster([row({ state: "retired", status: "retired" })]);

    const replay = await w.tap();
    const other = await retireAgent("act-2", { op: { kind: "retire-agent", name: NAME, agentId: AGENT_ID, force: false }, confirmEvent: CONFIRM }, w.deps);

    expect(replay).toEqual({ outcome: "already", name: NAME });
    expect(other).toMatchObject({ outcome: "gone" });
  });

  // Kills: dropping the agent id comparison, so a reused name retires a different agent (CC-408).
  it("answers moved with the current agent id when the name now belongs to another agent, and retires nothing", async () => {
    const w = world();
    w.setRoster([row({ state: "retired", status: "retired" }), row({ agentId: "77aa0011" })]);

    expect(await w.tap()).toEqual({ outcome: "moved", currentAgentId: "77aa0011" });
    expect(w.retireCalls()).toBeUndefined();
  });

  // Kills: treating a live, detached or reconnecting agent as ended, which retires a running process.
  it.each([
    ["live and connected", { state: "live", presence: "live", status: "running" }],
    ["detached in the background", { state: "detached", presence: "detached", status: "detached" }],
    ["live but reconnecting", { state: "live", presence: "detached", status: "reconnecting" }],
    ["exited but still connected", { state: "exited", presence: "live", status: "running" }],
  ])("refuses an agent that is %s and calls no retire", async (_label, fields) => {
    const w = world();
    w.setRoster([row(fields)]);

    expect(await w.tap()).toMatchObject({ outcome: "refused", reason: "class" });
    expect(w.retireCalls()).toBeUndefined();
  });

  describe("forced", () => {
    const NOW = Date.parse("2031-03-05T00:10:00.000Z");
    const exitedAgo = (ms: number) => new Date(NOW - ms).toISOString();
    const forcedWorld = (fields: Record<string, unknown>) => {
      const w = world();
      w.deps.now = () => NOW;
      w.setRoster([row(fields)]);
      return w;
    };

    it("refuses an agent exited 119 s ago, inside agent-chat's grace, and calls no retire", async () => {
      const w = forcedWorld({ exitedAt: exitedAgo(119_000) });

      expect(await w.tap({ force: true })).toMatchObject({ outcome: "refused", reason: "class", detail: expect.stringMatching(/^Wait 1 s/) });
      expect(w.retireCalls()).toBeUndefined();
    });

    it("retires an agent exited 121 s ago with --force", async () => {
      const w = forcedWorld({ exitedAt: exitedAgo(121_000) });

      expect(await w.tap({ force: true })).toMatchObject({ outcome: "retired", name: NAME });
      expect(w.retireCalls()).toEqual(["agent", "retire", NAME, "--force"]);
    });

    it.each([
      ["carries no exitedAt", {}],
      ["carries a null exitedAt", { exitedAt: null }],
      ["is live, whatever its exitedAt", { state: "live", presence: "live", status: "running", exitedAt: exitedAgo(600_000) }],
    ])("refuses a row that %s and calls no retire", async (_label, fields) => {
      const w = forcedWorld(fields);

      expect(await w.tap({ force: true })).toMatchObject({ outcome: "refused", reason: "class" });
      expect(w.retireCalls()).toBeUndefined();
    });
  });

  // Kills: dropping the Shepherd check, so a fix round's implementer is retired under a live run.
  it("refuses an agent that implements a live Shepherd run, and retires it once that run is no longer live", async () => {
    const w = world();
    const runId = await w.registerLive(NAME);

    const refused = await w.tap();
    w.host.runtime.cancel(runId, "done in this test");
    const after = await retireAgent("act-3", { op: { kind: "retire-agent", name: NAME, agentId: AGENT_ID, force: false }, confirmEvent: CONFIRM }, w.deps);

    expect(refused).toMatchObject({ outcome: "refused", reason: "class", detail: expect.stringContaining(runId) });
    expect(after).toMatchObject({ outcome: "retired" });
  });

  // Kills: checking only the implementer, so a fix-round successor recorded as an author is retired.
  it("refuses an agent recorded as an author of a live Shepherd run", async () => {
    const w = world();
    const runId = await w.registerLive("impl-a");
    w.deps.services.store.get().recordAuthor(runId, { agentId: AGENT_ID, name: NAME, role: "successor" });

    expect(await w.tap()).toMatchObject({ outcome: "refused", reason: "class", detail: expect.stringContaining(runId) });
    expect(w.retireCalls()).toBeUndefined();
  });

  // Kills: collapsing a broker refusal into unavailable, or the other way round.
  it("answers a broker refusal verbatim as refused resolver, and a broker that is down as agent-chat-unavailable", async () => {
    const w = world();
    writeFileSync(join(w.dir, "refuse.txt"), "Not retired: the worktree holds uncommitted work; pass --force\n");
    const refusal = await w.tap();
    rmSync(join(w.dir, "refuse.txt"));
    writeFileSync(join(w.dir, "down"), "");

    const down = await w.tap();

    expect(refusal).toMatchObject({ outcome: "refused", reason: "resolver", detail: expect.stringContaining("holds uncommitted work") });
    expect(down).toMatchObject({ outcome: "refused", reason: "agent-chat-unavailable" });
  });

  it("answers agent-chat-unavailable when serve has no agent-chat binary", async () => {
    const w = world();

    const outcome = await retireAgent("act-1", { op: { kind: "retire-agent", name: NAME, agentId: AGENT_ID, force: false }, confirmEvent: CONFIRM }, { ...w.deps, agentChat: undefined });

    expect(outcome).toMatchObject({ outcome: "refused", reason: "agent-chat-unavailable" });
  });
});
