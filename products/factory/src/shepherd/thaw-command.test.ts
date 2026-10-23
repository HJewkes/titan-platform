import { tmpdir } from "node:os";
import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { EXIT } from "@titan-design/registry";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import type { FactoryContext } from "../registry.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { eventsSince } from "./events.js";
import { freezeStoreRef } from "./freeze.js";
import { formatShepherd } from "./format.js";
import type { MainRedWiring } from "./main-red.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import type { ThawAlertPorts } from "./services.js";
import { shepherdStoreRef } from "./store.js";
import { thawCommand } from "./thaw-command.js";

const RED_SHA = fakeSha("hand-thaw-red");
const LATER_RED = fakeSha("hand-thaw-later-red");
const FIXER = "fix-demo-aaaaaaa";
const FIXER_POLICY: EffectivePolicy = { ...OWNER_GATE_POLICY, fixer: true, seat: "demo-seat" };
const REASON = "flaky timer test; rerun was green at the red sha";

const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  vi.restoreAllMocks();
});

const mainRed: Omit<MainRedWiring, "freezes"> = {
  tasks: { findByTag: async () => undefined, add: async () => "FX-9" },
  fixers: { roster: async () => [], spawn: async () => undefined },
  checkoutFor: () => tmpdir(),
};

interface Sent {
  seat: string;
  text: string;
}

function alertTo(sent: Sent[], send?: ThawAlertPorts["send"]): ThawAlertPorts {
  return { hubSeat: () => "hub-seat", redSeat: (repo) => (repo === REPO ? "red-seat" : undefined), send: send ?? (async (seat, text) => void sent.push({ seat, text })) };
}

/** PR 1 merges onto a main that is red at its merge sha; `thawAlert` is where a hand thaw's alert goes. */
function redMainWorld(thawAlert?: ThawAlertPorts) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const base = githubPort(fake.wire);
  const red = [successRun("validate", 5, undefined, "failure"), successRun("dag-check", 6)];
  const port = { ...base, checkRuns: async (repo: string, sha: string) => (sha === fake.pr(1).mergeSha && fake.setRuns(sha, red), base.checkRuns(repo, sha)) };
  let clock = 0;
  const store = shepherdStoreRef();
  const freeze = freezeStoreRef(() => clock);
  const routes = factoryRoutesFor({ port, store, freeze, now: () => clock, sleep: async (ms, signal) => (signal.throwIfAborted(), void (clock += ms)), mainRed, ...(thawAlert && { thawAlert }) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  const ctx = partialFake<FactoryContext>({ host, shepherd: routes.shepherd! });
  return { host, store, ctx, freezes: () => freeze.get() };
}

type World = ReturnType<typeof redMainWorld>;

/** The repo is frozen at RED_SHA with a fix task and a fixer, as `sh-freeze` and its steps leave it. */
function frozenWithFixer(w: World): number {
  const freezes = w.freezes();
  const { episode } = freezes.freeze(REPO, RED_SHA);
  freezes.setFixTask(REPO, episode, "demo/FX-1");
  freezes.setFixer(REPO, episode, FIXER);
  return episode;
}

const thaw = (w: World, args: Partial<{ redSha: string; reason: string; actor: string }> = {}) =>
  thawCommand.run(thawCommand.args.parse({ repo: REPO, redSha: RED_SHA, reason: REASON, actor: "demo-seat", ...args }), w.ctx);

const thawEvents = (w: World) => eventsSince(w.host.db).filter((event) => event.kind === "thaw");

describe("shepherd thaw", () => {
  it("thaws the live episode, records the caller and reason, and leaves its fix task open", async () => {
    const w = redMainWorld(alertTo([]));
    const episode = frozenWithFixer(w);

    const result = await thaw(w);

    expect(w.freezes().isFrozen(REPO)).toBe(false);
    expect(result).toMatchObject({ repo: REPO, episode, redSha: RED_SHA, actor: "demo-seat", fixTask: "demo/FX-1" });
    expect(thawEvents(w)).toEqual([expect.objectContaining({ repo: REPO, actor: "demo-seat", headSha: RED_SHA, reason: `hand thaw: ${REASON}` })]);
  });

  it("refuses a red sha that is not the episode's, so a moved red is never thawed blind", async () => {
    const w = redMainWorld(alertTo([]));
    frozenWithFixer(w);
    w.freezes().freeze(REPO, LATER_RED);

    const refused = thaw(w);

    await expect(refused).rejects.toMatchObject({ code: EXIT.DATAERR, message: expect.stringContaining(`is red at ${LATER_RED}`) });
    expect(w.freezes().get(REPO)).toMatchObject({ redSha: LATER_RED });
    expect(thawEvents(w)).toEqual([]);
  });

  it("refuses a repo with no open main-red episode", async () => {
    const w = redMainWorld(alertTo([]));
    const episode = frozenWithFixer(w);
    w.freezes().release(REPO, episode, "owner");

    await expect(thaw(w)).rejects.toMatchObject({ code: EXIT.DATAERR, message: expect.stringContaining("no open main-red episode") });
    expect(thawEvents(w)).toHaveLength(1);
  });

  it("refuses an empty or blank reason before anything is read", () => {
    expect(thawCommand.args.safeParse({ repo: REPO, redSha: RED_SHA, reason: "  " }).success).toBe(false);
    expect(thawCommand.args.safeParse({ repo: REPO, redSha: RED_SHA }).success).toBe(false);
  });

  it("alerts the repo's red seat with the repo, sha, caller and reason", async () => {
    const sent: Sent[] = [];
    const w = redMainWorld(alertTo(sent));
    frozenWithFixer(w);

    const result = await thaw(w);

    expect(result.alert).toEqual({ seat: "red-seat", sent: true, detail: "told red-seat" });
    expect(sent).toEqual([{ seat: "red-seat", text: expect.stringContaining(`demo-seat thawed main-red freeze episode 1 on ${REPO} by hand at red sha ${RED_SHA}`) }]);
    expect(sent[0]!.text).toContain(REASON);
  });

  it("still thaws when the alert fails, and logs the failure as an error line", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = redMainWorld(alertTo([], async () => Promise.reject(new Error("broker down"))));
    frozenWithFixer(w);

    const result = await thaw(w);

    expect(w.freezes().isFrozen(REPO)).toBe(false);
    expect(result.alert).toMatchObject({ seat: "red-seat", sent: false, detail: expect.stringContaining("the alert to red-seat failed") });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining(`hand thaw of ${REPO} at ${RED_SHA} by demo-seat alerted no seat`));
  });

  it("logs an error line and thaws when no alert route is configured", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = redMainWorld();
    frozenWithFixer(w);

    const result = await thaw(w);

    expect(w.freezes().isFrozen(REPO)).toBe(false);
    expect(result.alert).toEqual({ seat: null, sent: false, detail: "no agent-chat is configured to send it" });
    expect(errors).toHaveBeenCalledOnce();
  });
});

describe("shepherd thaw and the episode's pending main gates", () => {
  it("cancels a pending main-red-again gate with a gate-cancel event, and the run cleans up", async () => {
    const w = redMainWorld(alertTo([]));
    frozenWithFixer(w);
    const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(FIXER_POLICY) });
    w.store.get().register({ repo: REPO, pr: 1, runId, task: "demo/FX-1", implementer: FIXER, policy: FIXER_POLICY });
    await gateOpened(w.host, gateId(runId, "approve-merge"));
    w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
    await gateOpened(w.host, gateId(runId, "main-red-again"));
    const redSha = w.freezes().get(REPO)!.redSha;

    const result = await thaw(w, { redSha });

    expect(result.closedGates).toEqual([{ runId, gateId: gateId(runId, "main-red-again"), episode: 1 }]);
    expect(w.host.gates.get(gateId(runId, "main-red-again"))?.status).toBe("cancelled");
    await w.host.runtime.wait(runId);
    expect(w.store.get().eventsOf(runId).filter((event) => event.kind === "gate-cancel")).toHaveLength(1);
    expect(formatShepherd("shepherd.thaw", result)).toContain(`cancelled ${gateId(runId, "main-red-again")}`);
  });
});
