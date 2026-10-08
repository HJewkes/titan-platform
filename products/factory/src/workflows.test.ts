import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineWorkflow } from "./definition.js";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { DEFAULT_EXIT_GRACE_MS, DEFAULT_SESSION_START_TIMEOUT_MS, DEFAULT_VERDICT_TIMEOUT_MS, REVIEW_STEPS, reviewPhase } from "./shepherd/review.js";
import { shepherdPrWorkflow } from "./shepherd/pr.js";
import { OWNER_GATE_POLICY } from "./shepherd/policy.js";
import type { SeatBook } from "./shepherd/seats.js";
import { WAKE_STEPS, wakePhase } from "./shepherd/wake.js";
import { H1, REPO, gateId, gateOpened } from "./test-support/land.js";
import { configuredRoutes, type FactoryRouteDeps } from "./workflows.js";
import { landPrWorkflow } from "./workflows/land-pr.js";
import { NO_COMMAND, type ChoreExec } from "./workflows/post-merge.js";
import { OWNER } from "./test-support/resolver.js";

const hosts: FactoryHost[] = [];
const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  servers.splice(0).forEach((server) => server.close());
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
  host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
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

const PROFILE = "rv-readonly";
const REVIEWER = { agentId: "agent-rv-1", sessionId: "session-rv-1" };

interface ReviewSceneOptions {
  /** The `shepherd.review` value; null leaves the key out. */
  review?: object | null;
  /** The remote the one seat binds to the checkout; null writes no seat file. */
  seatRemote?: string | null;
  /** True puts the checkout on the seat's own deny list. */
  denied?: boolean;
  /** False makes the spawn succeed without the reviewer ever reaching the roster. */
  starts?: boolean;
  /** What the reviewer's transcript ends with; the default is a MERGE for `repo` at H1. */
  lastWords?: string;
  /** What a resume appends to the transcript as the reviewer's reply; absent makes `agent resume` fail. */
  reply?: string;
  repo?: string;
}

interface ReviewScene {
  dir: string;
  env: NodeJS.ProcessEnv;
  checkout: string;
  transcript: string;
  /** One line per run of the fake agent-chat: its arguments, space-joined. */
  calls: () => string[];
}

/**
 * A fake `agent-chat`: `agent ls` prints the roster file, `agent spawn` records its cwd and puts the reviewer on the roster as exited,
 * and `agent resume` appends the scene's reply record to the transcript, or fails when there is none.
 */
function fakeAgentChat(dir: string, starts: boolean, transcript: string): string {
  const bin = join(dir, "agent-chat");
  const joinRoster = starts ? `sed "s/@NAME@/$3/" "${dir}/roster.template" >"${dir}/roster.json"` : ":";
  const resume = `  resume) [ -f "${dir}/reply.jsonl" ] || exit 1; cat "${dir}/reply.jsonl" >>"${transcript}" ;;`;
  const lines = ["#!/bin/sh", `printf '%s\\n' "$*" >>"${dir}/calls"`, 'case "$2" in', `  ls) cat "${dir}/roster.json" 2>/dev/null || printf '[]' ;;`, `  spawn) pwd -P >"${dir}/spawn-cwd"; cat >/dev/null; ${joinRoster} ;;`, resume, "esac"];
  writeFileSync(bin, `${lines.join("\n")}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const assistantSaid = (n: number, timestamp: string, text: string) => ({ type: "assistant", sessionId: REVIEWER.sessionId, uuid: `assistant-${n}`, timestamp, message: { id: `response-${n}`, role: "assistant", model: "claude-test", content: [{ type: "text", text }] } });
const jsonl = (records: readonly object[]) => records.map((record) => `${JSON.stringify(record)}\n`).join("");

/** The reviewer reads one file and gets its text back, so its verdict clears the review depth floor. */
const readOneFile = [
  { type: "assistant", sessionId: REVIEWER.sessionId, uuid: "assistant-read", timestamp: "2026-09-30T10:01:00Z", message: { id: "response-read", role: "assistant", model: "claude-test", content: [{ type: "tool_use", id: "tool-read", name: "Read", input: { file_path: "src/a.ts" } }] } },
  { type: "user", sessionId: REVIEWER.sessionId, uuid: "result-read", timestamp: "2026-09-30T10:01:01Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-read", content: "export const a = 1;" }] } },
];

/** A finished Claude Code transcript of the reviewer's session whose last assistant text is `lastWords`. */
function writeTranscript(dir: string, lastWords: string): string {
  const path = join(dir, "transcripts", `${REVIEWER.sessionId}.jsonl`);
  const records = [{ type: "user", sessionId: REVIEWER.sessionId, uuid: "user-1", timestamp: "2026-09-30T10:00:00Z", message: { role: "user", content: "review it" } }, ...readOneFile, assistantSaid(1, "2026-09-30T10:05:00Z", lastWords)];
  mkdirSync(join(dir, "transcripts"));
  writeFileSync(path, jsonl(records));
  return path;
}

/** Everything lives under one temp dir, which is also the home the seat book sees: the config, the seat, the checkout, the fake agent-chat and the transcript. */
function reviewScene(options: ReviewSceneOptions = {}): ReviewScene {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "factory-review-")));
  dirs.push(dir);
  vi.stubEnv("HOME", dir);
  const checkout = join(dir, "checkouts", "demo");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(join(dir, "seats"));
  const seatRemote = options.seatRemote === undefined ? REPO : options.seatRemote;
  const deny = options.denied ? `deny_repos:\n  - ${checkout}\n` : "";
  if (seatRemote !== null) writeFileSync(join(dir, "seats", "demo.md"), `---\nschema: autonomy-seat/v1\nname: demo-seat\nrepos:\n  - path: ${checkout}\n    remote: ${seatRemote}\n${deny}---\n`);
  const transcript = writeTranscript(dir, options.lastWords ?? `Read it all.\n\nVerdict: MERGE\nPR: ${options.repo ?? REPO}#1\nHead: ${H1}\n`);
  const row = { name: "@NAME@", ...REVIEWER, state: "exited", presence: "exited", status: "finished", profile: PROFILE, cwd: checkout, transcriptPath: transcript, transcriptExists: true };
  writeFileSync(join(dir, "roster.template"), JSON.stringify([row]));
  const review = options.review === undefined ? { profile: PROFILE } : options.review;
  if (options.reply !== undefined) writeFileSync(join(dir, "reply.jsonl"), jsonl([{ type: "user", sessionId: REVIEWER.sessionId, uuid: "user-2", timestamp: "2026-09-30T10:06:00Z", message: { role: "user", content: "correct it" } }, assistantSaid(2, "2026-09-30T10:07:00Z", options.reply)]));
  const shepherd = { seatsDir: join(dir, "seats"), agentChatBin: fakeAgentChat(dir, options.starts ?? true, transcript), ...(review !== null && { review }) };
  mkdirSync(join(dir, "titan-factory"));
  writeFileSync(join(dir, "titan-factory", "config.json"), JSON.stringify({ shepherd }));
  const calls = (): string[] => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trimEnd().split("\n") : []);
  return { dir, env: { XDG_CONFIG_HOME: dir }, checkout, transcript, calls };
}

interface Reviewed {
  /** The `result` of the step with this id, undefined when the step never ran. */
  result: (stepId: string) => unknown;
  /** Milliseconds the run slept on the fake clock. */
  elapsed: number;
}

/** Runs the review phase for PR 1 at H1 on the production route set, over a fake GitHub and a fake clock. */
async function reviewWith(scene: ReviewScene, overrides: Partial<FactoryRouteDeps> = {}, repo: string = REPO): Promise<Reviewed> {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  let clock = 0;
  const routes = configuredRoutes(scene.env, { port: githubPort(fake.wire), now: () => clock, sleep: async (ms) => void (clock += ms), spawnGate: { admit: () => undefined }, ...overrides });
  const workflow = defineWorkflow({ name: "review-wiring", steps: REVIEW_STEPS, run: async (ctx) => void (await reviewPhase(ctx, { repo, pr: 1, round: 0, headSha: H1 })) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [workflow], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("review-wiring");
  await host.runtime.wait(runId);
  const results = Object.values(host.runtime.status(runId)!.stepResults);
  return { result: (stepId) => (results.find((found) => found.stepId === stepId)?.data as { result?: unknown } | undefined)?.result, elapsed: clock };
}

const REVIEW_INTENT = `sh-review-intent:${H1}`;
const REVIEW = `sh-review:${H1}`;
const AWAIT_VERDICT = `sh-await-verdict:${H1}`;
const MERGE_EVIDENCE = `sh-merge-evidence:${H1}`;

describe("configuredRoutes with shepherd.review", () => {
  it("spawns a reviewer through the configured agent-chat in the seat's checkout and takes its MERGE to the evidence step", async () => {
    const scene = reviewScene();

    const { result } = await reviewWith(scene);

    expect(result(REVIEW)).toMatchObject({ kind: "dispatched", mode: "spawn", reviewer: "rv-octo-demo-1", head: H1, ...REVIEWER });
    expect(scene.calls()).toContain(`agent spawn rv-octo-demo-1 ${PROFILE} --brief-stdin`);
    expect(readFileSync(join(scene.dir, "spawn-cwd"), "utf8").trim()).toBe(scene.checkout);
    expect(result(AWAIT_VERDICT)).toMatchObject({ kind: "verdict", verdict: "MERGE", head: H1 });
    expect(result(MERGE_EVIDENCE)).toMatchObject({ head: H1, merge: { resolver: REVIEWER, dispatchedReviewer: REVIEWER, repoFrozen: false } });
  });

  it("reads the verdict from the transcript that the spawning agent-chat's roster names for the reviewer", async () => {
    const scene = reviewScene();

    const { result } = await reviewWith(scene);

    expect(result(AWAIT_VERDICT)).toMatchObject({ kind: "verdict", reviewer: REVIEWER, locator: { source: { path: scene.transcript, conversation: { nativeId: REVIEWER.sessionId } } } });
    const calls = scene.calls();
    const spawnAt = calls.findIndex((call) => call.startsWith("agent spawn"));
    expect(calls.slice(0, spawnAt)).toEqual(["agent ls --json"]);
    expect(calls.slice(spawnAt + 1)).toContain("agent ls --json");
  });

  it("starts no agent-chat process and answers none when the config has no shepherd.review key", async () => {
    const scene = reviewScene({ review: null });

    const { result } = await reviewWith(scene);

    expect(result(REVIEW_INTENT)).toMatchObject({ kind: "none" });
    expect(result(REVIEW)).toBeUndefined();
    expect(result(AWAIT_VERDICT)).toBeUndefined();
    expect(scene.calls()).toEqual([]);
  });

  it("answers none and spawns nobody for a repo that no seat binds to a checkout", async () => {
    const scene = reviewScene({ seatRemote: "octo/other" });

    const { result } = await reviewWith(scene);

    expect(result(REVIEW)).toMatchObject({ kind: "none", reason: "the reviewer dispatch was refused: ReviewCheckoutUnusable" });
    expect(scene.calls()).toEqual(["agent ls --json"]);
  });

  it("spawns nobody for a repo on a seat deny list, though a seat binds it to a checkout", async () => {
    const scene = reviewScene({ denied: true });

    const { result } = await reviewWith(scene);

    expect(result(REVIEW)).toMatchObject({ kind: "none", reason: "the reviewer dispatch was refused: ReviewCheckoutUnusable" });
    expect(scene.calls()).toEqual(["agent ls --json"]);
  });

  it("finds the checkout of a repo whose name the PR writes in another case", async () => {
    const scene = reviewScene({ repo: "Octo/Demo" });

    const { result } = await reviewWith(scene, {}, "Octo/Demo");

    expect(result(REVIEW)).toMatchObject({ kind: "dispatched" });
    expect(readFileSync(join(scene.dir, "spawn-cwd"), "utf8").trim()).toBe(scene.checkout);
  });

  it("takes the checkout from a seat book passed in place of the configured one", async () => {
    const scene = reviewScene({ seatRemote: null });
    const book: SeatBook = { seats: [{ name: "demo-seat", remotes: [REPO], paths: { [REPO]: scene.checkout }, grants: [] }], denied: [] };

    const { result } = await reviewWith(scene, { seats: () => book });

    expect(result(REVIEW)).toMatchObject({ kind: "dispatched" });
    expect(readFileSync(join(scene.dir, "spawn-cwd"), "utf8").trim()).toBe(scene.checkout);
  });

  it("spawns the reviewer with the configured Claude config directory", async () => {
    const scene = reviewScene({ review: { profile: "rv-other", configDir: "/srv/rv-claude" } });

    await reviewWith(scene);

    expect(scene.calls()).toContain("agent spawn rv-octo-demo-1 rv-other --config-dir /srv/rv-claude --brief-stdin");
  });

  it("gives up on a reviewer that starts no session once shepherd.review.sessionStartTimeoutMs has passed", async () => {
    const scene = reviewScene({ review: { profile: PROFILE, sessionStartTimeoutMs: 60_000 }, starts: false });

    const { result, elapsed } = await reviewWith(scene);

    expect(result(REVIEW)).toMatchObject({ kind: "none", reason: expect.stringContaining("did not start") });
    expect(elapsed).toBeGreaterThanOrEqual(60_000);
    expect(elapsed).toBeLessThan(DEFAULT_SESSION_START_TIMEOUT_MS);
  });

  it("gives up on a reviewer that ends without a verdict once shepherd.review.verdictTimeoutMs has passed", async () => {
    const scene = reviewScene({ review: { profile: PROFILE, verdictTimeoutMs: 30_000 }, lastWords: "Still reading." });

    const { result, elapsed } = await reviewWith(scene);

    expect(result(AWAIT_VERDICT)).toMatchObject({ kind: "none", malformed: { refusal: "no_block" } });
    expect(elapsed).toBeGreaterThanOrEqual(30_000);
    expect(elapsed).toBeLessThan(DEFAULT_EXIT_GRACE_MS);
  });

  it("gives up one exit grace after the roster shows the reviewer exited with no verdict, long before the verdict timeout", async () => {
    const scene = reviewScene({ lastWords: "Still reading." });

    const { result, elapsed } = await reviewWith(scene);

    expect(result(AWAIT_VERDICT)).toMatchObject({ kind: "none", malformed: { refusal: "no_block" } });
    expect(elapsed).toBeGreaterThanOrEqual(DEFAULT_EXIT_GRACE_MS);
    expect(elapsed).toBeLessThan(DEFAULT_VERDICT_TIMEOUT_MS);
  });

  it("resumes a reviewer whose final message has no verdict through agent resume, and takes the MERGE it writes to the same transcript", async () => {
    const scene = reviewScene({ lastWords: "Looks fine to me.", reply: `Read it all.\n\nVerdict: MERGE\nPR: ${REPO}#1\nHead: ${H1}\n` });

    const { result } = await reviewWith(scene);

    expect(result(`sh-correct-verdict:${H1}`)).toMatchObject({ kind: "asked" });
    expect(scene.calls().filter((call) => call.startsWith("agent resume"))).toEqual([expect.stringMatching(/^agent resume rv-octo-demo-1 --message Your last message did not end with a verdict/)]);
    expect(result(`${AWAIT_VERDICT}:corrected`)).toMatchObject({ kind: "verdict", verdict: "MERGE", head: H1, reviewer: REVIEWER });
    expect(result(MERGE_EVIDENCE)).toMatchObject({ head: H1, merge: { resolver: REVIEWER, dispatchedReviewer: REVIEWER } });
  });

  it("hands the freeze check it is given to the merge evidence", async () => {
    const asked: string[] = [];
    const isFrozen = async (repo: string): Promise<boolean> => (asked.push(repo), true);

    const { result } = await reviewWith(reviewScene(), { isFrozen });

    expect(result(MERGE_EVIDENCE)).toMatchObject({ merge: { repoFrozen: true } });
    expect(asked).toEqual([REPO]);
  });
});

describe("configuredRoutes with shepherd.agentChatBin", () => {
  /** The wake step's record for an unregistered run: a configured binary gets as far as the registration read. */
  async function wakeResult(env: NodeJS.ProcessEnv): Promise<unknown> {
    const fake = fakeGitHub();
    fake.addPr({ headSha: H1 });
    const routes = configuredRoutes(env, { port: githubPort(fake.wire) });
    const request = { kind: "ci-red" as const, repo: REPO, pr: 1, round: 0, headSha: H1, payload: {} };
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [defineWorkflow({ name: "wake-wiring", steps: WAKE_STEPS, run: async (ctx) => void (await wakePhase(ctx, request)) })], routes, gatePollMs: 5 });
    hosts.push(host);
    const runId = host.runtime.start("wake-wiring");
    await host.runtime.wait(runId);
    return (Object.values(host.runtime.status(runId)!.stepResults)[0]?.data as { result?: unknown } | undefined)?.result;
  }

  it("hands the configured agent-chat binary to the wake step", async () => {
    expect(await wakeResult(reviewScene().env)).toMatchObject({ kind: "unhandled", reason: expect.stringMatching(/has no shepherd registration$/) });
  });

  it("leaves every wake unhandled when no binary is configured", async () => {
    expect(await wakeResult(configHome(undefined))).toEqual({ kind: "unhandled", reason: "shepherd.agentChatBin is not configured" });
  });
});

describe("factoryRoutes", () => {
  it("reads the config on first call, not when the module is imported", async () => {
    const env = configHome(undefined);
    mkdirSync(join(env.XDG_CONFIG_HOME!, "titan-factory"));
    writeFileSync(join(env.XDG_CONFIG_HOME!, "titan-factory", "config.json"), "{ not json");
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
    try {
      vi.resetModules();
      const fresh = await import("./workflows.js");

      expect(() => fresh.factoryRoutes()).toThrow(/invalid config .*config\.json/);
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });
});

/** A loopback active-work daemon that lists `demo/TP-1` as open until `task.done` closes it. */
async function fakeActiveWork(): Promise<{ port: number; calls: string[] }> {
  const calls: string[] = [];
  let status = "open";
  const server = createServer((req, res) => {
    const command = (req.url ?? "").replace("/rpc/", "");
    calls.push(command);
    if (command === "task.done") status = "done";
    const data = command === "task.list" ? { tasks: [{ id: "TP-1", status }] } : {};
    req.resume().on("end", () => res.setHeader("content-type", "application/json").end(JSON.stringify({ ok: true, data })));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, calls };
}

/** A fake `agent-chat` whose roster holds `impl-a`, exited, until `agent retire` removes it. */
function fakeRetiringAgentChat(dir: string): string {
  const bin = join(dir, "agent-chat");
  const row = JSON.stringify([{ name: "impl-a", agentId: "agent-impl-a", state: "exited", presence: "exited", status: "finished", profile: "implementer", cwd: dir, sessionId: "session-impl-a" }]);
  writeFileSync(join(dir, "roster.json"), row);
  const lines = ["#!/bin/sh", `printf '%s\\n' "$*" >>"${dir}/calls"`, 'case "$2" in', `  ls) cat "${dir}/roster.json" ;;`, `  retire) printf '[]' >"${dir}/roster.json"; echo "Retired $3" ;;`, "esac"];
  writeFileSync(bin, `${lines.join("\n")}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("configuredRoutes with shepherd.agentChatBin", () => {
  it("closes the registration's task over loopback rpc and retires its implementer through agent-chat after a merge", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "factory-cleanup-")));
    dirs.push(dir);
    mkdirSync(join(dir, "seats"));
    mkdirSync(join(dir, "titan-factory"));
    writeFileSync(join(dir, "titan-factory", "config.json"), JSON.stringify({ shepherd: { seatsDir: join(dir, "seats"), agentChatBin: fakeRetiringAgentChat(dir) } }));
    const activeWork = await fakeActiveWork();
    const fake = fakeGitHub();
    fake.addPr({ headSha: H1 });
    fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
    const base = githubPort(fake.wire);
    const port = { ...base, checkRuns: async (repo: string, sha: string) => (sha === fake.pr(1).mergeSha && fake.setRuns(sha, [successRun("validate", 5), successRun("dag-check", 6)]), base.checkRuns(repo, sha)) };
    let clock = 0;
    const env = { XDG_CONFIG_HOME: dir, AW_PORT: String(activeWork.port) };
    const routes = configuredRoutes(env, { port, now: () => clock, sleep: async (ms) => void (clock += ms) });
    const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow()], routes, gatePollMs: 5 });
    hosts.push(host);
    const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    routes.shepherd!.store.get().register({ repo: REPO, pr: 1, runId, task: "demo/TP-1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    await gateOpened(host, gateId(runId, "approve-merge"));
    host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);

    await host.runtime.wait(runId);

    expect(activeWork.calls).toEqual(["task.list", "task.list", "task.edit", "task.done"]);
    expect(readFileSync(join(dir, "calls"), "utf8")).toContain("agent retire impl-a\n");
    expect(readFileSync(join(dir, "calls"), "utf8")).not.toContain("--force");
  });
});
