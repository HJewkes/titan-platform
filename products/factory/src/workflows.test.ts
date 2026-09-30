import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineWorkflow } from "./definition.js";
import { openFactoryHost, type FactoryHost } from "./host.js";
import { DEFAULT_SESSION_START_TIMEOUT_MS, DEFAULT_VERDICT_TIMEOUT_MS, REVIEW_STEPS, reviewPhase } from "./shepherd/review.js";
import type { SeatBook } from "./shepherd/seats.js";
import { H1, REPO, gateId, gateOpened } from "./test-support/land.js";
import { configuredRoutes, type FactoryRouteDeps } from "./workflows.js";
import { landPrWorkflow } from "./workflows/land-pr.js";
import { NO_COMMAND, type ChoreExec } from "./workflows/post-merge.js";

const hosts: FactoryHost[] = [];
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
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

/** A fake `agent-chat`: `agent ls` prints the roster file, `agent spawn` records its cwd and puts the reviewer on the roster as exited. */
function fakeAgentChat(dir: string, starts: boolean): string {
  const bin = join(dir, "agent-chat");
  const joinRoster = starts ? `sed "s/@NAME@/$3/" "${dir}/roster.template" >"${dir}/roster.json"` : ":";
  const lines = ["#!/bin/sh", `printf '%s\\n' "$*" >>"${dir}/calls"`, 'case "$2" in', `  ls) cat "${dir}/roster.json" 2>/dev/null || printf '[]' ;;`, `  spawn) pwd -P >"${dir}/spawn-cwd"; cat >/dev/null; ${joinRoster} ;;`, "esac"];
  writeFileSync(bin, `${lines.join("\n")}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** A finished Claude Code transcript of the reviewer's session whose last assistant text is `lastWords`. */
function writeTranscript(dir: string, lastWords: string): string {
  const path = join(dir, "transcripts", `${REVIEWER.sessionId}.jsonl`);
  const records = [
    { type: "user", sessionId: REVIEWER.sessionId, uuid: "user-1", timestamp: "2026-09-30T10:00:00Z", message: { role: "user", content: "review it" } },
    { type: "assistant", sessionId: REVIEWER.sessionId, uuid: "assistant-1", timestamp: "2026-09-30T10:05:00Z", message: { id: "response-1", role: "assistant", model: "claude-test", content: [{ type: "text", text: lastWords }] } },
  ];
  mkdirSync(join(dir, "transcripts"));
  writeFileSync(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
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
  const shepherd = { seatsDir: join(dir, "seats"), agentChatBin: fakeAgentChat(dir, options.starts ?? true), ...(review !== null && { review }) };
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
  const routes = configuredRoutes(scene.env, { port: githubPort(fake.wire), now: () => clock, sleep: async (ms) => void (clock += ms), ...overrides });
  const workflow = defineWorkflow({ name: "review-wiring", steps: REVIEW_STEPS, run: async (ctx) => void (await reviewPhase(ctx, { repo, pr: 1, round: 0, headSha: H1 })) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [workflow], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("review-wiring");
  await host.runtime.wait(runId);
  const results = Object.values(host.runtime.status(runId)!.stepResults);
  return { result: (stepId) => (results.find((found) => found.stepId === stepId)?.data as { result?: unknown } | undefined)?.result, elapsed: clock };
}

const REVIEW = `sh-review:${H1}`;
const AWAIT_VERDICT = `sh-await-verdict:${H1}`;
const MERGE_EVIDENCE = `sh-merge-evidence:${H1}`;

describe("configuredRoutes with shepherd.review", () => {
  it("spawns a reviewer through the configured agent-chat in the seat's checkout and takes its MERGE to the evidence step", async () => {
    const scene = reviewScene();

    const { result } = await reviewWith(scene);

    expect(result(REVIEW)).toMatchObject({ kind: "dispatched", mode: "spawn", reviewer: "rv-demo-1", head: H1, ...REVIEWER });
    expect(scene.calls()).toContain(`agent spawn rv-demo-1 ${PROFILE} --brief-stdin`);
    expect(readFileSync(join(scene.dir, "spawn-cwd"), "utf8").trim()).toBe(scene.checkout);
    expect(result(AWAIT_VERDICT)).toMatchObject({ kind: "verdict", verdict: "MERGE", head: H1 });
    expect(result(MERGE_EVIDENCE)).toMatchObject({ head: H1, merge: { resolver: REVIEWER, dispatchedReviewer: REVIEWER, repoFrozen: false } });
  });

  it("reads the verdict from the transcript that the spawning agent-chat's roster names for the reviewer", async () => {
    const scene = reviewScene();

    const { result } = await reviewWith(scene);

    expect(result(AWAIT_VERDICT)).toMatchObject({ kind: "verdict", reviewer: REVIEWER, locator: { source: { path: scene.transcript, conversation: { nativeId: REVIEWER.sessionId } } } });
    expect(scene.calls().filter((call) => call === "agent ls --json").length).toBeGreaterThanOrEqual(3);
  });

  it("starts no agent-chat process and answers none when the config has no shepherd.review key", async () => {
    const scene = reviewScene({ review: null });

    const { result } = await reviewWith(scene);

    expect(result(REVIEW)).toMatchObject({ kind: "none" });
    expect(result(AWAIT_VERDICT)).toBeUndefined();
    expect(scene.calls()).toEqual([]);
  });

  it("answers none and spawns nobody for a repo that no seat binds to a checkout", async () => {
    const scene = reviewScene({ seatRemote: "octo/other" });

    const { result } = await reviewWith(scene);

    expect(result(REVIEW)).toMatchObject({ kind: "none", reason: expect.stringContaining(`no checkout path is configured for ${REPO}`) });
    expect(scene.calls()).toEqual(["agent ls --json"]);
  });

  it("spawns nobody for a repo on a seat deny list, though a seat binds it to a checkout", async () => {
    const scene = reviewScene({ denied: true });

    const { result } = await reviewWith(scene);

    expect(result(REVIEW)).toMatchObject({ kind: "none", reason: expect.stringContaining(`no checkout path is configured for ${REPO}`) });
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
    const scene = reviewScene({ review: { profile: PROFILE, configDir: "/srv/rv-claude" } });

    await reviewWith(scene);

    expect(scene.calls()).toContain(`agent spawn rv-demo-1 ${PROFILE} --config-dir /srv/rv-claude --brief-stdin`);
  });

  it("gives up on a reviewer that starts no session once shepherd.review.sessionStartTimeoutMs has passed", async () => {
    const scene = reviewScene({ review: { profile: PROFILE, sessionStartTimeoutMs: 60_000 }, starts: false });

    const { result, elapsed } = await reviewWith(scene);

    expect(result(REVIEW)).toMatchObject({ kind: "none", reason: expect.stringContaining("did not start") });
    expect(elapsed).toBeGreaterThanOrEqual(60_000);
    expect(elapsed).toBeLessThan(DEFAULT_SESSION_START_TIMEOUT_MS);
  });

  it("gives up on a reviewer that ends without a verdict once shepherd.review.verdictTimeoutMs has passed", async () => {
    const scene = reviewScene({ review: { profile: PROFILE, verdictTimeoutMs: 90_000 }, lastWords: "Still reading." });

    const { result, elapsed } = await reviewWith(scene);

    expect(result(AWAIT_VERDICT)).toEqual({ kind: "none" });
    expect(elapsed).toBeGreaterThanOrEqual(90_000);
    expect(elapsed).toBeLessThan(DEFAULT_VERDICT_TIMEOUT_MS);
  });

  it("hands the freeze check it is given to the merge evidence", async () => {
    const asked: string[] = [];
    const isFrozen = async (repo: string): Promise<boolean> => (asked.push(repo), true);

    const { result } = await reviewWith(reviewScene(), { isFrozen });

    expect(result(MERGE_EVIDENCE)).toMatchObject({ merge: { repoFrozen: true } });
    expect(asked).toEqual([REPO]);
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
