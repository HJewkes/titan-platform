import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIENT_HEADER, silentLogger } from "@titan-design/daemon";
import { fakeGitHub, githubPort } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { startFactoryServer, type FactoryServer } from "../serve.js";
import { OWNER_GATE_POLICY } from "../shepherd/policy.js";
import { shepherdFixture } from "../test-support/shepherd.js";
import { CONSOLE_ACTION_PATH } from "./route.js";

const REPO = "example-org/example-repo";
const TASK = "example/TP-1";
const SKILL = { gate: "skill", scope: { paths: [".claude/skills/x/SKILL.md"] }, round: "plan-r1" };

const dirs: string[] = [];
const servers: FactoryServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

async function world() {
  const dir = mkdtempSync(join(tmpdir(), "factory-plan-approval-relay-"));
  dirs.push(dir);
  const actionsDir = join(dir, "actions");
  mkdirSync(actionsDir);
  const fixture = shepherdFixture({ frozen: true, port: githubPort(fakeGitHub({ repo: REPO }).wire) });
  const server = await startFactoryServer({
    dbPath: join(dir, "factory.sqlite3"),
    workflows: [],
    routes: fixture.routes,
    resyncOnStart: false,
    port: 0,
    logger: silentLogger,
    github: { status: () => "ok", refresh: async () => undefined },
    build: { sha: "test", behindMain: { status: () => 0, refresh: async () => undefined } },
    consoleAnswers: { roundsDir: join(dir, "rounds"), actionsDir },
  });
  servers.push(server);
  return { server, actionsDir, store: () => fixture.routes.shepherd!.store.get() };
}

async function post(server: FactoryServer, actionId: string): Promise<[number, unknown]> {
  const res = await fetch(`http://127.0.0.1:${server.port}${CONSOLE_ACTION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", [CLIENT_HEADER]: "test" },
    body: JSON.stringify({ actionId }),
  });
  return [res.status, await res.json()];
}

describe("POST /owner/console-action plan-approval, relayed", () => {
  it("refuses a record marked decided with 422 record, as TP-3637 refuses a decided waive-proof, and no registration claims an approval", async () => {
    const w = await world();
    const action = { kind: "plan-approval", task: TASK, repo: REPO, ...SKILL, provenance: "decided" };
    writeFileSync(join(w.actionsDir, "plan-decided.json"), JSON.stringify({ itemId: "round:plan-r1/skill", action }), { mode: 0o600 });

    const answer = await post(w.server, "plan-decided");
    w.store().register({ repo: REPO, pr: 1, runId: "run-1", task: TASK, implementer: "impl-a", policy: OWNER_GATE_POLICY });

    expect(answer).toMatchObject([422, { outcome: "refused", reason: "record" }]);
    expect(w.store().planApprovals().forRun("run-1", TASK, REPO)).toEqual([]);
  });
});
