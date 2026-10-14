import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { GateResolver } from "@titan-design/hitl";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliDeps } from "../cli.js";
import type { OwnerPresence } from "../gate-resolve.js";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { createFactoryRegistry } from "../registry.js";
import { H1, REPO } from "../test-support/land.js";
import { callCommand, shepherdFixture } from "../test-support/shepherd.js";
import { SHEPHERD_COMMAND_MAP } from "./commands.js";
import { ownerRelease } from "./owner-release.js";
import { OWNER_GATE_POLICY } from "./policy.js";

const OWNER = "owner-asked: discuss scope; demo#1";
const G10 = "g10-review: auth change";
const H2 = "b".repeat(40);
const PROOF = "0b6f2c1e-6f1d-4c3a-9e1b-2d4c6a8e0f13";
const AGENT_SHELL = { AGENT_CHAT_AGENT_ID: "agent-1", AGENT_CHAT_NAME: "tc-synthetic" };
const OWNER_TERMINAL: GateResolver = { class: "owner-terminal", id: "owner", channel: "factory-cli" };
const COORDINATOR: GateResolver = { class: "coordinator", id: "tc-synthetic", channel: "factory-cli" };

const hosts: FactoryHost[] = [];
const dirs: string[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

/** A registered run on `REPO#1` at `H1`, with the holds given placed in order, in a database file a CLI can open after. */
function world(...holds: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "factory-owner-release-"));
  dirs.push(dir);
  const dbPath = join(dir, "factory.sqlite3");
  const fixture = shepherdFixture({ frozen: true });
  fixture.fake.addPr({ headSha: H1 });
  const host = openFactoryHost({ dbPath, workflows: fixture.workflows, routes: fixture.routes, gatePollMs: 5 });
  hosts.push(host);
  const services = fixture.routes.shepherd!;
  services.store.get().register({ repo: REPO, pr: 1, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  for (const reason of holds) services.store.get().hold("run-1", reason);
  return { dir, dbPath, fixture, host, store: () => services.store.get(), port: services.port };
}

const releases = (w: ReturnType<typeof world>) => w.store().eventsOf("run-1").filter((event) => event.kind === "release");

describe("ownerRelease", () => {
  it("lifts the owner-asked hold for an owner-terminal resolver at the PR's head, recording who", async () => {
    const w = world(OWNER);

    const after = await ownerRelease(w.store(), w.port, { repo: REPO, pr: 1, head: H1 }, OWNER_TERMINAL);

    expect(after).toMatchObject({ held: false, ownerHold: null });
    expect(releases(w).map((event) => [event.reason, event.actor, event.headSha])).toEqual([[OWNER, "owner-terminal:owner", H1]]);
  });

  it("refuses a coordinator resolver with exit 77, writing nothing", async () => {
    const w = world(OWNER);

    const refused = ownerRelease(w.store(), w.port, { repo: REPO, pr: 1, head: H1 }, COORDINATOR);

    await expect(refused).rejects.toMatchObject({ code: 77, message: expect.stringContaining("coordinator tc-synthetic is refused") });
    expect(w.store().byRun("run-1")?.ownerHold).toMatchObject({ reason: OWNER });
    expect(releases(w)).toEqual([]);
  });

  it("refuses a head the PR is not at, exit 65, and keeps the hold", async () => {
    const w = world(OWNER);

    const refused = ownerRelease(w.store(), w.port, { repo: REPO, pr: 1, head: H2 }, OWNER_TERMINAL);

    await expect(refused).rejects.toMatchObject({ code: 65, message: expect.stringContaining(`is at ${H1}, not ${H2}`) });
    expect(w.store().byRun("run-1")?.ownerHold).toMatchObject({ reason: OWNER });
    expect(releases(w)).toEqual([]);
  });

  it("refuses a run with no owner-asked hold, exit 65, and leaves its other hold alone", async () => {
    const w = world(G10);

    const refused = ownerRelease(w.store(), w.port, { repo: REPO, pr: 1, head: H1 }, OWNER_TERMINAL);

    await expect(refused).rejects.toMatchObject({ code: 65, message: expect.stringContaining("holds no owner-asked hold") });
    expect(w.store().byRun("run-1")).toMatchObject({ held: true, holdReason: G10 });
    expect(releases(w)).toEqual([]);
  });

  it("lifts the owner's hold only, so a seat's hold placed with it still gates", async () => {
    const w = world(OWNER, G10);

    const after = await ownerRelease(w.store(), w.port, { repo: REPO, pr: 1, head: H1 }, OWNER_TERMINAL);

    expect(after).toMatchObject({ held: true, holdReason: G10, ownerHold: null });
  });
});

describe("titan-factory shepherd owner-release", () => {
  function presenceStub(proof: string | undefined): { presence: OwnerPresence; reasons: string[] } {
    const reasons: string[] = [];
    return { reasons, presence: async (reason) => (reasons.push(reason), proof) };
  }

  /** Runs the verb on `w`'s database, then reopens it so the test reads what the CLI wrote. */
  async function ownerReleaseCli(w: ReturnType<typeof world>, env: NodeJS.ProcessEnv, presence: OwnerPresence, head = H1) {
    w.host.close();
    hosts.splice(hosts.indexOf(w.host), 1);
    let out = "";
    let err = "";
    const io = { stdout: (t: string) => void (out += t), stderr: (t: string) => void (err += t), env: { XDG_CONFIG_HOME: w.dir, ...env } };
    const deps: CliDeps = { workflows: w.fixture.workflows, routes: w.fixture.routes, host: { gatePollMs: 5 }, presence };
    const code = await runCli(["--db", w.dbPath, "shepherd", "owner-release", `${REPO}#1`, "--head", head], io, deps);
    hosts.push(openFactoryHost({ dbPath: w.dbPath, workflows: w.fixture.workflows, routes: w.fixture.routes, gatePollMs: 5 }));
    return { code, out, err };
  }

  it("refuses an agent's shell when the owner does not confirm presence, exit 77, writing nothing", async () => {
    const w = world(OWNER);
    const { presence, reasons } = presenceStub(undefined);

    const { code, err } = await ownerReleaseCli(w, AGENT_SHELL, presence);

    expect(code).toBe(77);
    expect(err).toContain("tc-synthetic, a shell agent-chat launched, is refused");
    expect(reasons).toEqual([`release the owner-asked hold on ${REPO}#1 at ${H1}`]);
    expect(w.store().byRun("run-1")?.ownerHold).toMatchObject({ reason: OWNER });
    expect(releases(w)).toEqual([]);
  });

  it("releases from an agent-chat shell once the owner confirms presence, recording the proof", async () => {
    const w = world(OWNER);

    const { code, out } = await ownerReleaseCli(w, AGENT_SHELL, presenceStub(PROOF).presence);

    expect(code).toBe(0);
    expect(out).toContain(`released the owner-asked hold on ${REPO}#1 at ${H1} as owner-terminal`);
    expect(releases(w).map((event) => event.actor)).toEqual([`owner-terminal:${userInfo().username} proof ${PROOF}`]);
  });

  it("releases from the owner's own terminal without asking for presence", async () => {
    const w = world(OWNER);
    const { presence, reasons } = presenceStub(undefined);

    const { code } = await ownerReleaseCli(w, {}, presence);

    expect(code).toBe(0);
    expect(reasons).toEqual([]);
    expect(w.store().byRun("run-1")).toMatchObject({ held: false, ownerHold: null });
  });

  it("refuses a head the PR is not at, from the owner's own terminal", async () => {
    const w = world(OWNER);

    const { code, err } = await ownerReleaseCli(w, {}, presenceStub(undefined).presence, H2);

    expect(code).toBe(65);
    expect(err).toContain(`is at ${H1}, not ${H2}`);
    expect(w.store().byRun("run-1")?.ownerHold).toMatchObject({ reason: OWNER });
  });

  it("refuses a run with no owner-asked hold before it asks the owner anything", async () => {
    const w = world(G10);
    const { presence, reasons } = presenceStub(PROOF);

    const { code, err } = await ownerReleaseCli(w, AGENT_SHELL, presence);

    expect(code).toBe(65);
    expect(err).toContain("holds no owner-asked hold");
    expect(reasons).toEqual([]);
    expect(releases(w)).toEqual([]);
  });

  it("refuses a --head that is not a full sha as usage", async () => {
    const w = world(OWNER);

    const { code } = await ownerReleaseCli(w, {}, presenceStub(undefined).presence, "abc123");

    expect(code).toBe(2);
    expect(w.store().byRun("run-1")?.ownerHold).toMatchObject({ reason: OWNER });
  });
});

describe("owner-release over the registry", () => {
  it("is no shepherd command, so no rpc or MCP caller reaches it", async () => {
    const w = world(OWNER);
    const names = createFactoryRegistry().list().map((command) => command.name);

    const called = await callCommand(w.host, w.fixture.routes, "shepherd.owner-release", { repo: REPO, pr: 1, head: H1 });

    expect(Object.keys(SHEPHERD_COMMAND_MAP).filter((name) => /owner.?release/i.test(name))).toEqual([]);
    expect(names.filter((name) => /owner.?release/i.test(name))).toEqual([]);
    expect(called.ok).toBe(false);
    expect(w.store().byRun("run-1")?.ownerHold).toMatchObject({ reason: OWNER });
  });
});
