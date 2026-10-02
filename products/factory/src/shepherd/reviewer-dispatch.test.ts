import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchError } from "@titan-design/agent-dispatch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewerBrokerBusy, ReviewerBrokerDown, type ReviewTarget } from "./review.js";
import { agentChatReviewerDispatch, expandHome, type AgentChatReviewerDispatchOptions } from "./reviewer-dispatch.js";

const PROFILE = "rv-readonly";
const BRIEF = "Review octo/demo#7. BRIEF-SENTINEL-4f2a";
const target: ReviewTarget = { repo: "octo/demo", pr: 7, head: "a".repeat(40) };
// The exact line agent-chat's client prints once its reconnect ladder runs out.
const BROKER_DOWN_LINE = "could not reach or start the agent-chat broker";
const BROKER_DOWN = `echo '${BROKER_DOWN_LINE}' >&2\nexit 1\n`;

let dir: string;
let home: string;
let checkout: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "titan-reviewer-dispatch-")));
  home = join(dir, "home");
  checkout = join(home, "projects", "demo");
  mkdirSync(checkout, { recursive: true });
  vi.stubEnv("HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake `agent-chat` that records its argv (NUL-separated), stdin and working directory, then runs `script`. */
function fakeAgentChat(script = "exit 0\n"): string {
  const bin = join(dir, "agent-chat");
  const record = [`: >"${dir}/argv"`, `for a in "$@"; do printf '%s\\0' "$a" >>"${dir}/argv"; done`, `pwd -P >"${dir}/cwd"`, `cat >"${dir}/stdin"`];
  writeFileSync(bin, `#!/bin/sh\n${record.join("\n")}\n${script}`);
  chmodSync(bin, 0o755);
  return bin;
}

const recorded = (name: string): string => readFileSync(join(dir, name), "utf8");
const recordedArgv = (): string[] => recorded("argv").split("\0").slice(0, -1);
const wasRun = (): boolean => existsSync(join(dir, "argv"));

const dispatchOver = (script?: string, over: Partial<AgentChatReviewerDispatchOptions> = {}) =>
  agentChatReviewerDispatch({ agentChatBin: fakeAgentChat(script), profile: PROFILE, cwdFor: () => checkout, ...over });

const failure = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => expect.unreachable("the call was expected to throw"),
    (error: unknown) => error,
  );

function expectRefusal(error: unknown, text: string): void {
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(ReviewerBrokerDown);
  expect((error as Error).message).toContain(text);
}

describe("expandHome", () => {
  it.each([
    ["~/projects/demo", "/srv/rv-home/projects/demo"],
    ["$HOME/projects/demo", "/srv/rv-home/projects/demo"],
    ["${HOME}/projects/demo", "/srv/rv-home/projects/demo"],
    ["/srv/demo", "/srv/demo"],
    ["/srv/~/demo", "/srv/~/demo"],
    ["/srv/$HOME/demo", "/srv/$HOME/demo"],
    ["~other/demo", "~other/demo"],
    ["$HOMEDIR/demo", "$HOMEDIR/demo"],
    ["~", "~"],
  ])("turns %s into %s", (path, expanded) => {
    expect(expandHome(path, "/srv/rv-home")).toBe(expanded);
  });
});

describe("agentChatReviewerDispatch roster", () => {
  const row = { name: "rv-demo-7", agentId: "agent-1", state: "exited", presence: "exited", status: "finished", profile: PROFILE, cwd: "/srv/demo", sessionId: "session-1" };

  const rosterOf = (rows: readonly unknown[]) => {
    writeFileSync(join(dir, "roster.json"), JSON.stringify(rows));
    return dispatchOver(`cat "${dir}/roster.json"\n`).roster();
  };

  it("reads `agent ls --json` and keeps the identity, presence, spawner and transcript of each row, and nothing else", async () => {
    const full = { ...row, surface: "headless", model: null, transcriptPath: "/srv/transcripts/session-1.jsonl", transcriptExists: true, spawnedBy: "coord", account: null, generation: 2, teleportFrom: "earlier" };

    const roster = await rosterOf([full]);

    expect(roster).toStrictEqual([
      { name: "rv-demo-7", agentId: "agent-1", sessionId: "session-1", presence: "exited", spawnedBy: "coord", transcriptPath: "/srv/transcripts/session-1.jsonl", transcriptExists: true },
    ]);
    expect(recordedArgv()).toEqual(["agent", "ls", "--json"]);
  });

  it("reports no spawner and no transcript for a row that carries neither", async () => {
    const roster = await rosterOf([row, { ...row, name: "rv-demo-8", spawnedBy: 7, transcriptPath: 7, transcriptExists: "yes" }]);

    const bare = { agentId: "agent-1", sessionId: "session-1", presence: "exited", spawnedBy: null, transcriptPath: null, transcriptExists: false };
    expect(roster).toStrictEqual([
      { name: "rv-demo-7", ...bare },
      { name: "rv-demo-8", ...bare },
    ]);
  });

  it("reports an unreachable broker as broker-down, so the caller asks again", async () => {
    const error = await failure(dispatchOver(BROKER_DOWN).roster());

    expect(error).toBeInstanceOf(ReviewerBrokerDown);
    expect((error as Error).message).toContain(BROKER_DOWN_LINE);
  });

  it("keeps a failed roster read that is not a broker outage a plain failure", async () => {
    const error = await failure(dispatchOver(`echo 'the log is locked'\nexit 1\n`).roster());

    expectRefusal(error, "the log is locked");
  });

  it("gives up on a roster read that outlasts its timeout, without calling it a broker outage", async () => {
    const error = await failure(dispatchOver("exec sleep 5\n", { rosterTimeoutMs: 200 }).roster());

    expectRefusal(error, "timed out");
  });
});

describe("agentChatReviewerDispatch spawn", () => {
  it("starts the reviewer under the configured profile in the repo's checkout, with the brief on stdin and not in argv", async () => {
    const repos: string[] = [];
    const dispatch = dispatchOver(undefined, { cwdFor: (repo) => (repos.push(repo), checkout) });

    await dispatch.spawn("rv-demo-7", BRIEF, target);

    expect(recordedArgv()).toEqual(["agent", "spawn", "rv-demo-7", PROFILE, "--brief-stdin"]);
    expect(recorded("argv")).not.toContain("SENTINEL");
    expect(recorded("stdin")).toBe(BRIEF);
    expect(recorded("cwd").trim()).toBe(checkout);
    expect(repos).toEqual(["octo/demo"]);
  });

  it("spawns with whichever profile was configured", async () => {
    await dispatchOver(undefined, { profile: "rv-other" }).spawn("rv-demo-7", BRIEF, target);

    expect(recordedArgv()).toEqual(["agent", "spawn", "rv-demo-7", "rv-other", "--brief-stdin"]);
  });

  it("passes the configured Claude config directory", async () => {
    await dispatchOver(undefined, { configDir: "/srv/claude-second" }).spawn("rv-demo-7", BRIEF, target);

    expect(recordedArgv()).toEqual(["agent", "spawn", "rv-demo-7", PROFILE, "--config-dir", "/srv/claude-second", "--brief-stdin"]);
  });

  it.each(["~/projects/demo", "$HOME/projects/demo", "${HOME}/projects/demo"])("starts the reviewer in the home checkout when the path is written %s", async (path) => {
    await dispatchOver(undefined, { cwdFor: () => path }).spawn("rv-demo-7", BRIEF, target);

    expect(recorded("cwd").trim()).toBe(checkout);
  });

  const unusable: readonly (readonly [string, () => string | undefined, string])[] = [
    ["has no checkout path", () => undefined, "no checkout path"],
    ["has an empty checkout path", () => "", "no checkout path"],
    ["has a checkout path that does not exist", () => join(home, "projects", "gone"), "not a directory"],
    ["has a checkout path that is a file", () => join(dir, "agent-chat"), "not a directory"],
    ["has a relative checkout path", () => "home/projects/demo", "not absolute"],
    ["names another user's home", () => "~other/projects/demo", "not absolute"],
    ["has a bare ~ for a path", () => "~", "not absolute"],
  ];

  it.each(unusable)("refuses and starts nothing when the repo %s", async (_name, cwdFor, text) => {
    const error = await failure(dispatchOver(undefined, { cwdFor }).spawn("rv-demo-7", BRIEF, target));

    expectRefusal(error, text);
    expect((error as Error).message).toContain("octo/demo");
    expect(wasRun()).toBe(false);
  });

  it("refuses a reviewer name agent-chat would not accept, and starts nothing", async () => {
    const error = await failure(dispatchOver().spawn("Rv Demo", BRIEF, target));

    expectRefusal(error, "invalid peer name");
    expect(wasRun()).toBe(false);
  });

  it("reports an unreachable broker as broker-down, so the spawn is asked again", async () => {
    const error = await failure(dispatchOver(BROKER_DOWN).spawn("rv-demo-7", BRIEF, target));

    expect(error).toBeInstanceOf(ReviewerBrokerDown);
    expect((error as Error).message).toContain(BROKER_DOWN_LINE);
  });

  it.each([
    ["on stdout", `echo 'the name rv-demo-7 is held; last error: ${BROKER_DOWN_LINE}'\nexit 1\n`],
    ["inside a longer stderr line", `echo 'refused: "${BROKER_DOWN_LINE}" was the last error' >&2\nexit 1\n`],
    ["as a whole stdout line", `echo '${BROKER_DOWN_LINE}'\nexit 1\n`],
  ])("keeps a refusal that quotes the broker-down line %s a refusal", async (_name, script) => {
    const error = await failure(dispatchOver(script).spawn("rv-demo-7", BRIEF, target));

    expect(error).toBeInstanceOf(DispatchError);
    expectRefusal(error, BROKER_DOWN_LINE);
  });

  it.each([
    ["the headless-agent total", "machine guard: 11 live headless agents machine-wide (limit 10, config machineHeadlessAgents); wait for one to exit"],
    ["the memory floor", "machine guard: memory 9% free (floor 15%, config machineMemoryFreePercent); wait for memory pressure to ease before spawning"],
  ])("reports a refusal by the machine guard (%s) as busy, carrying the guard's reason alone", async (_name, reason) => {
    const error = await failure(dispatchOver(`echo 'Not spawned: ${reason}'\nexit 1\n`).spawn("rv-demo-7", BRIEF, target));

    expect(error).toBeInstanceOf(ReviewerBrokerBusy);
    expect((error as Error).message).toBe(reason);
  });

  it("keeps a refusal that only mentions the machine guard mid-sentence a refusal", async () => {
    const error = await failure(dispatchOver(`echo 'Not spawned: no machine guard: reading'\nexit 1\n`).spawn("rv-demo-7", BRIEF, target));

    expect(error).not.toBeInstanceOf(ReviewerBrokerBusy);
    expectRefusal(error, "no machine guard");
  });

  it("keeps a spawn that timed out a refusal, because the reviewer may be running", async () => {
    const error = await failure(dispatchOver("exec sleep 5\n", { spawnTimeoutMs: 200 }).spawn("rv-demo-7", BRIEF, target));

    expectRefusal(error, "timed out");
  });

  it("refuses when the agent-chat executable is missing", async () => {
    const dispatch = agentChatReviewerDispatch({ agentChatBin: join(dir, "absent"), profile: PROFILE, cwdFor: () => checkout });

    expectRefusal(await failure(dispatch.spawn("rv-demo-7", BRIEF, target)), "not found");
  });
});

describe("agentChatReviewerDispatch resume", () => {
  it("resumes the named agent through agent-chat with the brief as its next message", async () => {
    await dispatchOver().resume("rv-standing", BRIEF);

    expect(recordedArgv()).toEqual(["agent", "resume", "rv-standing", "--message", BRIEF]);
  });

  it("reports an unreachable broker as broker-down", async () => {
    expect(await failure(dispatchOver(BROKER_DOWN).resume("rv-standing", BRIEF))).toBeInstanceOf(ReviewerBrokerDown);
  });

  it("reports a resume refused by the machine guard as busy", async () => {
    const error = await failure(dispatchOver(`echo 'machine guard: 11 live headless agents machine-wide' >&2\nexit 1\n`).resume("rv-standing", BRIEF));

    expect(error).toBeInstanceOf(ReviewerBrokerBusy);
  });

  it("keeps a refused resume a refusal", async () => {
    const error = await failure(dispatchOver(`echo 'rv-standing is live'\nexit 1\n`).resume("rv-standing", BRIEF));

    expectRefusal(error, "rv-standing is live");
  });

  it("keeps a resume that timed out a refusal", async () => {
    const error = await failure(dispatchOver("exec sleep 5\n", { spawnTimeoutMs: 200 }).resume("rv-standing", BRIEF));

    expectRefusal(error, "timed out");
  });
});
