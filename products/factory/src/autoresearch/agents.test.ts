import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Digest, Idea, ImplementRequest } from "@titan-design/autoresearch";
import { parseLimits } from "@titan-design/agent-dispatch/limits";
import { priceRequest } from "@titan-design/session-analytics";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { arAgentPorts, plannerName, type ArAgentsOptions } from "./agents.js";
import { loadWaitPort } from "./load-wait.js";
import { resumeContract } from "./planner-brief.js";

let dir: string;
let clone: string;
let bases: string[];
const signal = new AbortController().signal;
/** Every test shells out to git and a node fake many times, which a loaded CI runner stretches past the defaults. */
const WAIT = { timeout: 20_000, interval: 10 };
vi.setConfig({ testTimeout: 60_000 });
const OPEN = { version: 1, pools: { agents: { config_dir: "/accounts/agents", ceiling_five_hour: 90, reserve_seven_day: 5 } } };

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...args], { cwd, encoding: "utf8" }).trim();

/**
 * A fake `agent-chat`: logs each call, serves `agent ls --json` from `roster.json`, and on a spawn or resume plays the
 * agent scripted in `behave/<name>.json`: an optional commit in its cwd, then transcript turns naming the commit.
 */
const FAKE = `
const fs = require("fs"), path = require("path"), cp = require("child_process");
const dir = process.env.AGENT_CHAT_HOME, args = process.argv.slice(2);
const rosterPath = path.join(dir, "roster.json");
const roster = fs.existsSync(rosterPath) ? JSON.parse(fs.readFileSync(rosterPath, "utf8")) : [];
const log = (extra) => fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({ args, ...extra }) + "\\n");
if (args[1] === "ls") { log({}); process.stdout.write(JSON.stringify(roster)); process.exit(0); }
const name = args[2];
const behave = JSON.parse(fs.readFileSync(path.join(dir, "behave", name + ".json"), "utf8"));
let row = roster.find((r) => r.name === name);
let brief;
if (args[1] === "spawn") {
  brief = fs.readFileSync(0, "utf8");
  row = { name, agentId: name, state: "exited", presence: "exited", status: "finished", profile: args[3], surface: "headless",
    cwd: process.cwd(), sessionId: "s-" + name, generation: 1, transcriptPath: path.join(dir, "t-" + name + ".jsonl") };
  roster.push(row);
}
const g = (...a) => cp.execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", ...a], { cwd: row.cwd, encoding: "utf8" }).trim();
log({ head: g("rev-parse", "HEAD"), brief });
if (behave.commit) { fs.writeFileSync(path.join(row.cwd, name + ".txt"), args[1]); g("add", "-A"); g("commit", "-qm", "work"); }
const head = g("rev-parse", "HEAD");
if (behave.pending) { row.presence = "live"; row.state = "live"; }
for (const turn of behave.turns || []) fs.appendFileSync(row.transcriptPath, turn.replace("{HEAD}", head) + "\\n");
fs.writeFileSync(rosterPath, JSON.stringify(roster));
`;

function assistantLine(requestId: string, text: string, cache: { read: number; w5m: number; w1h: number }): string {
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: cache.read, cache_creation_input_tokens: cache.w5m + cache.w1h,
    cache_creation: { ephemeral_5m_input_tokens: cache.w5m, ephemeral_1h_input_tokens: cache.w1h } };
  return JSON.stringify({ type: "assistant", sessionId: "s", cwd: dir, timestamp: "2026-10-21T00:00:00Z", requestId,
    message: { role: "assistant", id: `m-${requestId}`, model: "claude-sonnet-5-5", usage, content: [{ type: "text", text }] } });
}

const final = (requestId: string, body: string, cache = { read: 0, w5m: 0, w1h: 0 }) => assistantLine(requestId, "Done.\n```json\n" + body + "\n```", cache);
const implemented = (requestId = "r-final") => final(requestId, '{"head": "{HEAD}", "lesson": "smaller is better"}');
const behave = (name: string, script: { commit?: boolean; pending?: boolean; turns?: string[] }) => writeFileSync(join(dir, "behave", `${name}.json`), JSON.stringify(script));

const calls = (): { args: string[]; head?: string; brief?: string }[] =>
  existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
const spawns = () => calls().filter((call) => call.args[1] === "spawn" || call.args[1] === "resume");
const roster = (): Record<string, unknown>[] => (existsSync(join(dir, "roster.json")) ? JSON.parse(readFileSync(join(dir, "roster.json"), "utf8")) : []);
const setRoster = (rows: Record<string, unknown>[]) => writeFileSync(join(dir, "roster.json"), JSON.stringify(rows));
const row = (name: string, cwd: string, presence = "exited") => ({ name, agentId: name, state: presence, presence, status: "x", profile: "impl", surface: "headless", cwd, sessionId: `s-${name}`, generation: 1, transcriptPath: join(dir, `t-${name}.jsonl`) });

function ports(overrides: Partial<ArAgentsOptions> = {}) {
  const bin = join(dir, "agent-chat");
  return arAgentPorts({
    clone, target: { name: "demo", adapterDir: "adapter" }, configDir: "/accounts/agents", account: "agents", plannerCwd: clone,
    agentChat: { bin, timeoutMs: 10_000, pollMs: 5 },
    profiles: { implementer: "impl", planner: "planner" },
    limits: { pool: "agents", read: () => parseLimits(OPEN) },
    load: { ceiling: 28, pollMs: 1 },
    ...overrides,
  });
}

const idea = (id: string): Idea => partialFake<Idea>({ id, class: "accept-gate", targets: [], mechanism: "m" });
const request = (tree: string, id: string, extra: Partial<ImplementRequest> = {}): ImplementRequest =>
  ({ runId: "run-1", idea: idea(id), tree, base: bases[0]!, brief: "make it faster", round: 1, lane: 1, fork: "explore", ...extra });
const nameFor = (tree: string, round: number, id: string) => basename(tree).replace(`-${id}`, `-r${round}-${id}`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ar-agents-"));
  mkdirSync(join(dir, "behave"));
  mkdirSync(join(dir, "profiles"));
  for (const profile of ["impl", "planner"]) writeFileSync(join(dir, "profiles", `${profile}.json`), JSON.stringify({ surface: "headless" }));
  writeFileSync(join(dir, "agent-chat.staging"), `#!${process.execPath}\n${FAKE}`);
  chmodSync(join(dir, "agent-chat.staging"), 0o755);
  cpSync(join(dir, "agent-chat.staging"), join(dir, "agent-chat"));
  vi.stubEnv("AGENT_CHAT_HOME", dir);
  clone = join(dir, "clone");
  mkdirSync(clone);
  git(clone, "init", "-q", "-b", "main");
  bases = ["one", "two"].map((text) => {
    writeFileSync(join(clone, "file.txt"), text);
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", text);
    return git(clone, "rev-parse", "HEAD");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("the load wait", () => {
  it("does not start a stage while the five-minute load equals the ceiling", async () => {
    const readings = [28.0, 27.9];
    const wait = loadWaitPort({ ceiling: 28, pollMs: 1, readLoad5: () => readings.shift() ?? 0 });

    const waited = await wait({ stage: "implement" }, signal);

    expect(waited.load5).toBe(27.9);
    expect(readings).toEqual([]);
  });

  it("keeps the deadline of the step's first start across a restart", async () => {
    const readings = [30, 30, 30, 1];
    const wait = loadWaitPort({ ceiling: 28, pollMs: 1, maxWaitMs: 5_000, readLoad5: () => readings.shift() ?? 0, now: () => Date.parse("2026-01-01T00:00:10Z") });

    await expect(wait({ stage: "implement", firstStartedAt: "2026-01-01T00:00:00Z" }, signal)).rejects.toThrow("[load-timeout] implement held 10000 ms");
    expect(readings).toHaveLength(3);
  });

  it("fails a stage held for exactly maxWaitMs", async () => {
    const readings = [30, 1];
    const wait = loadWaitPort({ ceiling: 28, pollMs: 1, maxWaitMs: 5_000, readLoad5: () => readings.shift() ?? 0, now: () => Date.parse("2026-01-01T00:00:05Z") });

    await expect(wait({ stage: "implement", firstStartedAt: "2026-01-01T00:00:00Z" }, signal)).rejects.toThrow("[load-timeout] implement held 5000 ms");
  });

  it("counts the wait from the step's first start, and from now when that start is unreadable", async () => {
    const wait = loadWaitPort({ ceiling: 28, pollMs: 1, readLoad5: () => 1, now: () => Date.parse("2026-01-01T00:00:10Z") });

    expect(await wait({ stage: "implement", firstStartedAt: "2026-01-01T00:00:04Z" }, signal)).toEqual({ waitedMs: 6_000, load5: 1 });
    expect(await wait({ stage: "implement", firstStartedAt: "not a time" }, signal)).toEqual({ waitedMs: 0, load5: 1 });
  });
});

describe("idea trees", () => {
  it("are cut at the requested base, not the clone's head", async () => {
    const { tree } = await ports().allocTree({ runId: "run-1", ideaId: "i-aaa", base: bases[0]!, lane: 1 }, signal);

    expect(git(tree, "rev-parse", "HEAD")).toBe(bases[0]);
  });

  it("are not released while a live agent's cwd is inside them", async () => {
    const p = ports();
    const { tree } = await p.allocTree({ runId: "run-1", ideaId: "i-aaa", base: bases[0]!, lane: 1 }, signal);
    setRoster([row("ar-other", join(tree, "sub"), "live")]);

    await expect(p.releaseTree({ tree }, signal)).rejects.toThrow("[tree-live]");
    expect(existsSync(tree)).toBe(true);
  });

  it("are released with their branch kept", async () => {
    const p = ports();
    const { tree, branch } = await p.allocTree({ runId: "run-1", ideaId: "i-aaa", base: bases[1]!, lane: 1 }, signal);

    await p.releaseTree({ tree }, signal);

    expect(existsSync(tree)).toBe(false);
    expect(git(clone, "rev-parse", "--verify", branch)).toBe(bases[1]);
  });
});

describe("implementers", () => {
  it("spawn on the agents account's config dir and report the head they committed", async () => {
    const p = ports();
    const { tree } = await p.allocTree({ runId: "run-1", ideaId: "i-aaa", base: bases[0]!, lane: 1 }, signal);
    behave(nameFor(tree, 1, "i-aaa"), { commit: true, turns: [implemented()] });

    const built = await p.implement(request(tree, "i-aaa"), signal);

    const argv = spawns()[0]!.args;
    expect(argv.slice(0, 4)).toEqual(["agent", "spawn", nameFor(tree, 1, "i-aaa"), "impl"]);
    expect(argv[argv.indexOf("--config-dir") + 1]).toBe("/accounts/agents");
    expect(built).toMatchObject({ head: git(tree, "rev-parse", "HEAD"), mode: "spawn", account: "agents", agent: nameFor(tree, 1, "i-aaa") });
  });

  it("adopt the idea tree rather than getting a fresh worktree from the default branch", async () => {
    const p = ports();
    const { tree } = await p.allocTree({ runId: "run-1", ideaId: "i-aaa", base: bases[0]!, lane: 1 }, signal);
    behave(nameFor(tree, 1, "i-aaa"), { commit: true, turns: [implemented()] });

    await p.implement(request(tree, "i-aaa"), signal);

    const argv = spawns()[0]!.args;
    expect(argv[argv.indexOf("--worktree") + 1]).toBe(tree);
  });

  it("are named from the request's run id, not from the tree they were handed", async () => {
    const p = ports();
    const { tree } = await p.allocTree({ runId: "run-1", ideaId: "i-aaa", base: bases[0]!, lane: 1 }, signal);
    const name = `${plannerName("run-2").replace(/-planner$/, "")}-r1-i-aaa`;
    behave(name, { commit: true, turns: [implemented()] });

    const built = await p.implement(request(tree, "i-aaa", { runId: "run-2" }), signal);

    expect(spawns()[0]!.args[2]).toBe(name);
    expect(built.agent).toBe(name);
  });

  it("sum cache reads and writes over every turn, counting a split response once", async () => {
    const p = ports();
    const { tree } = await p.allocTree({ runId: "run-1", ideaId: "i-aaa", base: bases[0]!, lane: 1 }, signal);
    const first = { read: 100, w5m: 10, w1h: 1 };
    const last = { read: 200, w5m: 20, w1h: 2 };
    behave(nameFor(tree, 1, "i-aaa"), { commit: true, turns: [assistantLine("r1", "reading", first), assistantLine("r1", "still r1", first), final("r2", '{"head": "{HEAD}"}', last)] });

    const built = await p.implement(request(tree, "i-aaa"), signal);

    expect(built.usage).toMatchObject({ cacheReadTokens: 300, cacheWrite5mTokens: 30, cacheWrite1hTokens: 3 });
    const priced = (cache: typeof first) => priceRequest({ inputTokens: 10, outputTokens: 5, cacheReadTokens: cache.read, cacheCreation5mTokens: cache.w5m, cacheCreation1hTokens: cache.w1h }, "claude-sonnet-5-5", "2026-10-21T00:00:00Z").costUsd;
    expect(built.usd).toBeGreaterThan(0);
    expect(built.usd).toBeCloseTo(priced(first) + priced(last), 12);
    expect(built.usage?.usd).toBe(built.usd);
  });

  it("refuse before any spawn when the limits close the pool", async () => {
    const p = ports({ limits: { pool: "agents", read: () => parseLimits({ version: 1, pools: {} }) } });
    const { tree } = await p.allocTree({ runId: "run-1", ideaId: "i-aaa", base: bases[0]!, lane: 1 }, signal);
    behave(nameFor(tree, 1, "i-aaa"), { commit: true, turns: [implemented()] });

    await expect(p.implement(request(tree, "i-aaa"), signal)).rejects.toThrow("[limits] pool agents has no limits");
    expect(spawns()).toEqual([]);
  });

  it("join an agent a restarted host already spawned instead of spawning it again", async () => {
    const p = ports();
    const { tree } = await p.allocTree({ runId: "run-1", ideaId: "i-aaa", base: bases[0]!, lane: 1 }, signal);
    const name = nameFor(tree, 1, "i-aaa");
    setRoster([row(name, tree)]);
    appendFileSync(join(dir, `t-${name}.jsonl`), implemented().replace("{HEAD}", bases[0]!) + "\n");

    const built = await p.implement(request(tree, "i-aaa"), signal);

    expect(spawns()).toEqual([]);
    expect(built.head).toBe(bases[0]);
  });

  it("on an exploit lane resume the winner in its re-created tree at the ratchet head", async () => {
    const p = ports();
    const { tree } = await p.allocTree({ runId: "run-1", ideaId: "i-bbb", base: bases[1]!, lane: 1 }, signal);
    const winnerHome = join(dir, "winner-tree");
    setRoster([row("ar-winner", winnerHome)]);
    behave("ar-winner", { commit: true, turns: [implemented()] });

    const built = await p.implement(request(tree, "i-bbb", { fork: "exploit", resumeFrom: "ar-winner", round: 2 }), signal);

    const [resume] = spawns();
    expect(resume?.args.slice(0, 3)).toEqual(["agent", "resume", "ar-winner"]);
    expect(resume?.head).toBe(bases[1]);
    expect(built).toMatchObject({ mode: "resume", resumedFrom: "ar-winner", agent: "ar-winner", head: git(tree, "rev-parse", "HEAD") });
    expect(existsSync(winnerHome)).toBe(false);
  });

  it("on an exploit lane resume a winner that adopted the idea tree in place, without moving it", async () => {
    const p = ports();
    const { tree } = await p.allocTree({ runId: "run-1", ideaId: "i-bbb", base: bases[1]!, lane: 1 }, signal);
    setRoster([row("ar-winner", tree)]);
    behave("ar-winner", { commit: true, turns: [implemented()] });

    const built = await p.implement(request(tree, "i-bbb", { fork: "exploit", resumeFrom: "ar-winner", round: 2 }), signal);

    expect(spawns()[0]?.head).toBe(bases[1]);
    expect(built).toMatchObject({ mode: "resume", agent: "ar-winner", head: git(tree, "rev-parse", "HEAD") });
    expect(existsSync(tree)).toBe(true);
  });

  it("on a resume count only the new turn's usage, not the winner's earlier turns", async () => {
    const p = ports();
    const { tree } = await p.allocTree({ runId: "run-1", ideaId: "i-bbb", base: bases[1]!, lane: 1 }, signal);
    setRoster([row("ar-winner", join(dir, "winner-tree"))]);
    appendFileSync(join(dir, "t-ar-winner.jsonl"), final("r-old", `{"head": "${bases[0]!}"}`, { read: 500, w5m: 50, w1h: 5 }) + "\n");
    behave("ar-winner", { commit: true, turns: [final("r-new", '{"head": "{HEAD}"}', { read: 7, w5m: 3, w1h: 1 })] });

    const built = await p.implement(request(tree, "i-bbb", { fork: "exploit", resumeFrom: "ar-winner", round: 2 }), signal);

    expect(built.usage).toMatchObject({ cacheReadTokens: 7, cacheWrite5mTokens: 3, cacheWrite1hTokens: 1 });
  });

  it("read the last fenced JSON block of the final message when it has several", async () => {
    const p = ports();
    const { tree } = await p.allocTree({ runId: "run-1", ideaId: "i-aaa", base: bases[0]!, lane: 1 }, signal);
    const text = 'Planned:\n```json\n{"head": "not-this-one"}\n```\nDone.\n```json\n{"head": "{HEAD}"}\n```';
    behave(nameFor(tree, 1, "i-aaa"), { commit: true, turns: [assistantLine("r1", text, { read: 0, w5m: 0, w1h: 0 })] });

    const built = await p.implement(request(tree, "i-aaa"), signal);

    expect(built.head).toBe(git(tree, "rev-parse", "HEAD"));
  });

  it("of later lanes start only after the round's first lane has answered", async () => {
    const p = ports();
    const one = await p.allocTree({ runId: "run-1", ideaId: "i-one", base: bases[0]!, lane: 1 }, signal);
    const two = await p.allocTree({ runId: "run-1", ideaId: "i-two", base: bases[0]!, lane: 2 }, signal);
    const first = nameFor(one.tree, 1, "i-one");
    behave(first, { commit: true, pending: true });
    behave(nameFor(two.tree, 1, "i-two"), { commit: true, turns: [implemented()] });

    const lanes = [p.implement(request(one.tree, "i-one"), signal), p.implement(request(two.tree, "i-two", { lane: 2 }), signal)];
    await vi.waitFor(() => expect(spawns()).toHaveLength(1), WAIT);
    await sleep(60);
    expect(spawns().map((call) => call.args[2])).toEqual([first]);

    appendFileSync(join(dir, `t-${first}.jsonl`), assistantLine("r0", "looking", { read: 0, w5m: 0, w1h: 0 }) + "\n");
    await vi.waitFor(() => expect(spawns()).toHaveLength(2), WAIT);
    // The fake rewrites the whole roster when lane 2's spawn finishes, so lane 1's exit is written only after that.
    await vi.waitFor(() => expect(roster().map((r) => r.name)).toContain(nameFor(two.tree, 1, "i-two")), WAIT);
    appendFileSync(join(dir, `t-${first}.jsonl`), implemented().replace("{HEAD}", git(one.tree, "rev-parse", "HEAD")) + "\n");
    setRoster(roster().map((r) => (r.name === first ? { ...r, presence: "exited" } : r)));

    await expect(Promise.all(lanes)).resolves.toHaveLength(2);
  });
});

describe("the planner", () => {
  it("is spawned in round 1 and resumed in round 2", async () => {
    const p = ports();
    const name = plannerName("run-1");
    behave(name, { turns: [final("p1", '{"add": []}')] });
    const input = { runId: "run-1", digest: partialFake<Digest>(), violations: [] };

    expect(await p.plan({ ...input, round: 1, mode: "spawn" }, signal)).toMatchObject({ ops: { add: [] }, agent: name, mode: "spawn" });
    behave(name, { turns: [final("p2", '{"add": [], "close": []}')] });
    expect(await p.plan({ ...input, round: 2, mode: "resume" }, signal)).toMatchObject({ ops: { add: [], close: [] }, agent: name, mode: "resume" });

    expect(spawns().map((call) => call.args.slice(0, 3))).toEqual([["agent", "spawn", name], ["agent", "resume", name]]);
  });

  it("is spawned with the program path and the ops contract, and resumed with the contract line", async () => {
    const p = ports();
    const name = plannerName("run-1");
    behave(name, { turns: [final("p1", '{"add": []}')] });
    const input = { runId: "run-1", digest: partialFake<Digest>(), violations: [] };

    await p.plan({ ...input, round: 1, mode: "spawn" }, signal);
    await p.plan({ ...input, round: 2, mode: "resume" }, signal);

    const [spawned, resumed] = spawns();
    expect(spawned!.brief).toContain(join(clone, "adapter", "program.md"));
    expect(spawned!.brief).toContain("End contract:");
    expect(resumed!.args[resumed!.args.indexOf("--message") + 1]).toContain(resumeContract);
  });

  it("reports its session and the cache reads of its turn beside the ops", async () => {
    const p = ports();
    const name = plannerName("run-1");
    behave(name, { turns: [final("p1", '{"add": []}', { read: 120, w5m: 12, w1h: 0 })] });

    const planned = await p.plan({ runId: "run-1", digest: partialFake<Digest>(), violations: [], round: 1, mode: "spawn" }, signal);

    expect(planned).toMatchObject({ sessionId: `s-${name}`, usage: { cacheReadTokens: 120, cacheWrite5mTokens: 12 } });
    expect(planned.usage!.usd).toBeGreaterThan(0);
  });
});
