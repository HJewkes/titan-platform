import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PEER_NAME_PATTERN, type AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import type { RoutedStepInput } from "@titan-design/workflow";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { hostCarryPorts } from "./carry-cache-adapter.js";
import { BUMP_FIXER_ROUNDS } from "./bump-fixer.js";
import { BUMP_BRANCH_PREFIX, consumerBumpImplementer } from "./consumer-bump.js";
import { mergeBaseExceptionMigration } from "./merge-base-exception.js";
import type { ShepherdDeps } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { lineageMigration, shepherdMigration, shepherdStoreRef, sliceMigration, type RegistrationInput } from "./store.js";
import { wakeRoutes, type ImplementerAgents, type WakeStepResult } from "./wake.js";

const REPO = "acme/consumer-a";
const PR = 1;
const H1 = fakeSha("bump-head");
const BRANCH = `${BUMP_BRANCH_PREFIX}0badc0de`;
const IMPLEMENTER = consumerBumpImplementer(REPO, PR);
const CHECKOUT = mkdtempSync(join(tmpdir(), "tp4909-bump-fixer-"));
afterAll(() => rmSync(CHECKOUT, { recursive: true, force: true }));
const SEAT_POLICY = { ...OWNER_GATE_POLICY, fixer: true, seat: "seat-a" };
const BUMP_RUN: RegistrationInput = { repo: REPO, pr: PR, branch: BRANCH, runId: "run-bump", task: "consumer-a/bump-consumers", implementer: IMPLEMENTER, policy: SEAT_POLICY };
const manifest = (spec: string): string => JSON.stringify({ dependencies: { "@titan-design/example-a": spec, "left-pad": "1.0.0" } }, null, 2);

function row(name: string, overrides: Partial<AgentRow> = {}): AgentRow {
  const base = { name, agentId: `id-${name}`, state: "exited", presence: "exited", status: "finished", profile: "implementer", surface: "headless", model: null };
  const session = { cwd: `/work/${name}`, sessionId: `s-${name}`, transcriptPath: `/transcripts/${name}.jsonl`, transcriptExists: true };
  return { ...base, ...session, spawnedBy: null, account: null, generation: 1, teleportFrom: null, ...overrides };
}

interface Asked {
  verb: "spawn" | "message" | "resume";
  name: string;
  message: string;
}

function fakeAgents(rows: AgentRow[]): ImplementerAgents & { asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    asked,
    roster: async () => rows.map((agent) => ({ ...agent })),
    resume: async (name, message) => void asked.push({ verb: "resume", name, message }),
    message: async (name, message) => void asked.push({ verb: "message", name, message }),
    spawn: async (name, message) => (asked.push({ verb: "spawn", name, message }), void rows.push(row(name, { presence: "live" }))),
  };
}

function bumpPr() {
  const fake = fakeGitHub({ repo: REPO });
  const pr = fake.addPr({ headSha: H1, headRef: BRANCH, baseRef: "main" });
  fake.prFiles.set(pr.number, [{ path: "package.json", status: "modified" }, { path: "pnpm-lock.yaml", status: "modified" }]);
  fake.files.set("main:package.json", { content: manifest("^1.3.0"), blobSha: "b1" });
  fake.files.set(`${H1}:package.json`, { content: manifest("^1.4.0"), blobSha: "b2" });
  return fake;
}

const WakeRecord = z.looseObject({ result: z.custom<WakeStepResult>() });

/** The sh-wake-implementer step alone for a sweep-registered run, with `successors` already in its lineage. */
function bumpWake(rows: AgentRow[], successors: readonly string[] = [], registration: RegistrationInput = BUMP_RUN) {
  const fake = bumpPr();
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), mergeBaseExceptionMigration(42)]);
  const store = shepherdStoreRef();
  store.bind(db);
  store.get().register(registration);
  for (const name of successors) store.get().recordAuthor(BUMP_RUN.runId, { agentId: `id-${name}`, name, role: "successor", predecessor: IMPLEMENTER });
  const agents = fakeAgents(rows);
  const deps: ShepherdDeps = { gitCache: hostCarryPorts, port: githubPort(fake.wire), store, now: () => 0, sleep: async () => undefined, pollMs: 1_000, agentChatBin: "/opt/bin/agent-chat" };
  const wiring = { agents, turnSince: async () => true, readWarmth: async () => undefined, checkoutFor: () => CHECKOUT };
  const route = wakeRoutes(deps, wiring).find((candidate) => candidate.match === "sh-wake-implementer")!;
  const run = async () => {
    const input = { kind: "ci-red", repo: REPO, pr: PR, round: 0, headSha: H1, payload: { failing: [{ name: "validate" }] }, runId: BUMP_RUN.runId };
    const signal = new AbortController().signal;
    const step: RoutedStepInput = { runId: BUMP_RUN.runId, workflowName: "bump-fixer-test", iteration: 0, prompt: JSON.stringify(input), signal, attempt: 0, requestKey: "k", stepId: "sh-wake-implementer:0" };
    const outcome = await route.runner.run(step);
    return outcome.ok ? WakeRecord.parse(JSON.parse(outcome.output)).result : undefined;
  };
  return { agents, run };
}

describe("a consumer bump run's fixer", () => {
  it("ci-red on a sweep-registered bump run starts a bump fixer with the generated brief", async () => {
    const { agents, run } = bumpWake([]);

    const result = await run();

    expect(result).toMatchObject({ kind: "woken", agent: `${IMPLEMENTER}-s1`, mode: "successor" });
    expect(agents.asked.map(({ verb, name }) => [verb, name])).toEqual([["spawn", `${IMPLEMENTER}-s1`]]);
    const brief = agents.asked[0]!.message;
    expect(brief).toContain("@titan-design/example-a: ^1.3.0 -> ^1.4.0 (package.json)");
    expect(brief).not.toContain("left-pad");
    expect(brief).toMatch(/failing checks[\s\S]*validate/);
    expect(brief).toContain("never pin a package back");
    expect(brief).toContain("never force-push");
    expect(brief).toContain("chat_send to seat-a");
    expect(brief).toContain(BRANCH);
    expect(brief).not.toContain("register with Shepherd as this PR's implementer");
  });

  it("a second ci-red while a fixer is live does not start another, and messages the live one", async () => {
    const live = `${IMPLEMENTER}-s1`;
    const { agents, run } = bumpWake([row(live, { presence: "live", state: "working", status: "working" })], [live]);

    const result = await run();

    expect(result).toMatchObject({ kind: "woken", agent: live, mode: "live" });
    expect(agents.asked.map(({ verb, name }) => [verb, name])).toEqual([["message", live]]);
  });

  it("past the round cap starts no fixer and leaves the wake unhandled, so the run's ci-failed route wakes the seat", async () => {
    const spent = Array.from({ length: BUMP_FIXER_ROUNDS }, (_, k) => `${IMPLEMENTER}-s${k + 1}`);
    const { agents, run } = bumpWake(spent.map((name) => row(name)), spent);

    const result = await run();

    expect(result).toMatchObject({ kind: "unhandled", reason: expect.stringContaining(`its ${BUMP_FIXER_ROUNDS} fixers`) });
    expect(agents.asked).toEqual([]);
  });

  it("gives a run off the sweep's implementer name the plain successor brief, though it is on a bump branch", async () => {
    const { agents, run } = bumpWake([row("seat-helper")], [], { ...BUMP_RUN, implementer: "seat-helper" });

    await run();

    expect(agents.asked[0]!.message).toContain("register with Shepherd as this PR's implementer");
  });
});

describe("consumerBumpImplementer", () => {
  it("names each bump run apart, as a peer name with room for a fixer suffix", () => {
    const long = consumerBumpImplementer(`acme/${"Very.Long_Repo".repeat(8)}`, 123456);

    expect(consumerBumpImplementer(REPO, 1)).not.toBe(consumerBumpImplementer(REPO, 2));
    expect(consumerBumpImplementer("acme/a", 1)).not.toBe(consumerBumpImplementer("acme/b", 1));
    expect(`${long}-s99`).toMatch(PEER_NAME_PATTERN);
    expect(long.endsWith("-123456")).toBe(true);
  });
});
