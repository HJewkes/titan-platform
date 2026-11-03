import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as childProcess from "node:child_process";
import { DispatchError } from "@titan-design/agent-dispatch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewTarget } from "@titan-design/review-panel";
import { isolateAgentChatHome } from "../test-support/agent-chat-home.js";
import { provablyIndependent } from "./lineage.js";
import { ReviewerBrokerBusy, ReviewerBrokerDown } from "./review.js";
import { ReviewerAskTimedOut, ReviewerMachineHold } from "./review-wait.js";
import { agentChatReviewerDispatch, expandHome, runningReviewStarts, type ReviewerRosterRow, type AgentChatReviewerDispatchOptions } from "./reviewer-dispatch.js";
import { createRosterReader } from "./roster.js";
import { spawnGate } from "./spawn-gate.js";
import { errorMessage } from "../narrow.js";

type ExecFileDone = (error: Error | null, stdout: string, stderr: string) => void;
type ExecFileOverride = (bin: string, args: string[], options: { timeout: number }, done: ExecFileDone) => unknown;
const execFileHook = vi.hoisted(() => ({ override: undefined as ExecFileOverride | undefined }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>();
  const execFile = (bin: string, args: string[], options: { timeout: number }, done: ExecFileDone): unknown =>
    execFileHook.override ? execFileHook.override(bin, args, options, done) : Reflect.apply(actual.execFile, undefined, [bin, args, options, done]);
  return { ...actual, execFile };
});

const PROFILE = "rv-readonly";
const BRIEF = "Review octo/demo#7. BRIEF-SENTINEL-4f2a";
const target: ReviewTarget = { repo: "octo/demo", pr: 7, head: "a".repeat(40) };
// The exact line agent-chat's client prints once its reconnect ladder runs out.
const BROKER_DOWN_LINE = "could not reach or start the agent-chat broker";
const BROKER_DOWN = `echo '${BROKER_DOWN_LINE}' >&2\nexit 1\n`;
// What agent-chat prints when AGENT_CHAT_NO_AUTOSTART=1 finds no broker listening, as at a boot race.
const NO_AUTOSTART_LINE = "broker unavailable: no broker is listening and AGENT_CHAT_NO_AUTOSTART=1 forbids starting one";

let dir: string;
let home: string;
let checkout: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "titan-reviewer-dispatch-")));
  home = join(dir, "home");
  checkout = join(home, "projects", "demo");
  mkdirSync(checkout, { recursive: true });
  isolateAgentChatHome(home, [PROFILE, "bd-reviewer", "reviewer", "rv-other"]);
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
  agentChatReviewerDispatch({ agentChatBin: fakeAgentChat(script), roles: { g10: PROFILE, standard: PROFILE }, cwdFor: () => checkout, ...over });

const failure = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => expect.unreachable("the call was expected to throw"),
    (error: unknown) => error,
  );

function expectRefusal(error: unknown, text: string): void {
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(ReviewerBrokerDown);
  expect(errorMessage(error)).toContain(text);
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
  const row = { name: "rv-demo-7", agentId: "agent-1", state: "exited", presence: "exited", status: "finished", profile: PROFILE, surface: "headless", cwd: "/srv/demo", sessionId: "session-1", generation: 1 };

  const rosterOf = (rows: readonly unknown[]) => {
    writeFileSync(join(dir, "roster.json"), JSON.stringify(rows));
    return dispatchOver(`cat "${dir}/roster.json"\n`).roster();
  };

  it("reads `agent ls --json` and keeps the identity, presence, spawner, profile, working directory and transcript of each row, and nothing else", async () => {
    const full = { ...row, model: null, transcriptPath: "/srv/transcripts/session-1.jsonl", transcriptExists: true, spawnedBy: "coord", account: null, generation: 2, teleportFrom: "earlier" };

    const roster = await rosterOf([full]);

    expect(roster).toStrictEqual([
      { name: "rv-demo-7", agentId: "agent-1", sessionId: "session-1", presence: "exited", spawnedBy: "coord", transcriptPath: "/srv/transcripts/session-1.jsonl", transcriptExists: true, profile: PROFILE, cwd: "/srv/demo" },
    ]);
    expect(recordedArgv()).toEqual(["agent", "ls", "--json"]);
  });

  it("reports when the session's transcript was last written, so a resume since an intent shows on the roster", async () => {
    const transcriptPath = join(dir, "session-1.jsonl");
    writeFileSync(transcriptPath, "{}\n");
    utimesSync(transcriptPath, 1_700_000_000, 1_700_000_000);

    const [found] = await rosterOf([{ ...row, transcriptPath, transcriptExists: true }]);

    expect(found).toMatchObject({ transcriptPath, lastWrittenAt: 1_700_000_000_000 });
  });

  it("reports no spawner and no transcript for a row that carries neither", async () => {
    const roster = await rosterOf([row, { ...row, name: "rv-demo-8", spawnedBy: 7, transcriptPath: 7, transcriptExists: "yes" }]);

    const bare = { agentId: "agent-1", sessionId: "session-1", presence: "exited", spawnedBy: null, transcriptPath: null, transcriptExists: false, profile: PROFILE, cwd: "/srv/demo" };
    expect(roster).toStrictEqual([
      { name: "rv-demo-7", ...bare },
      { name: "rv-demo-8", ...bare },
    ]);
  });

  it.each([
    ["names the agent it took over from", "rv-demo-6", { predecessor: "rv-demo-6" }],
    ["says it took over from no one", null, { predecessor: null }],
  ])("carries the predecessor of a row that %s", async (_scene, predecessor, expected) => {
    const [found] = await rosterOf([{ ...row, predecessor }]);

    expect(found).toMatchObject(expected);
  });

  it("reports no predecessor for a row that carries none, rather than claiming it took over from no one", async () => {
    const roster = await rosterOf([row, { ...row, name: "rv-demo-8", predecessor: 7 }]);

    expect(roster.map((agent) => "predecessor" in agent)).toEqual([false, false]);
  });

  describe("lineage proof over the roster it reads", () => {
    const seat = (name: string, spawnedBy: string | null, over: Record<string, unknown>) => ({ ...row, name, agentId: `agent-${name}`, spawnedBy, ...over });
    const crew = (over: Record<string, unknown>) => [seat("coord", null, over), seat("impl-a", "coord", over), seat("rv-demo-7", "coord", over)];

    it("proves a reviewer independent when every row says it took over from no one", async () => {
      const roster = await rosterOf(crew({ predecessor: null }));
      const reviewer = roster.find((agent) => agent.name === "rv-demo-7");

      expect(reviewer && provablyIndependent(reviewer, "impl-a", { rows: roster, complete: true })).toBe(true);
    });

    it("cannot prove a reviewer independent from rows that carry no predecessor", async () => {
      const roster = await rosterOf(crew({}));
      const reviewer = roster.find((agent) => agent.name === "rv-demo-7");

      expect(reviewer && provablyIndependent(reviewer, "impl-a", { rows: roster, complete: true })).toBe(false);
    });
  });

  describe("retired generations", () => {
    const seat = (name: string, spawnedBy: string | null, over: Record<string, unknown> = {}) => ({ ...row, name, agentId: `agent-${name}-${String(over.generation ?? 1)}`, spawnedBy, predecessor: null, ...over });
    /** The seat's first generation, retired, is the only row that says the implementer spawned the seat. */
    const retiredFirst = seat("seat", "impl-a", { state: "retired", retired: true });
    const rows = [retiredFirst, seat("seat", "seat", { generation: 2, predecessor: "seat" }), seat("impl-a", null), seat("rv-demo-7", "seat")];

    /** Prints `rows` for any `agent ls`; `predatesFlag` refuses `--include-retired` the way commander does on an older agent-chat. */
    const brokerOf = (printed: readonly unknown[], predatesFlag = false) => {
      writeFileSync(join(dir, "roster.json"), JSON.stringify(printed));
      const refuse = predatesFlag ? `for a in "$@"; do [ "$a" = --include-retired ] && { echo "error: unknown option '--include-retired'" >&2; exit 1; }; done\n` : "";
      return dispatchOver(`${refuse}cat "${dir}/roster.json"\n`);
    };

    it("never offers a retired row as a reviewer on the roster", async () => {
      const roster = await brokerOf(rows).roster();

      expect(roster.map((agent) => [agent.name, agent.agentId])).not.toContainEqual(["seat", retiredFirst.agentId]);
      expect(roster).toHaveLength(rows.length - 1);
      expect(recordedArgv()).toEqual(["agent", "ls", "--json"]);
    });

    it("refuses a reviewer whose seat's retired first generation the implementer spawned", async () => {
      const dispatch = brokerOf(rows);
      const reviewer = (await dispatch.roster()).find((agent) => agent.name === "rv-demo-7");
      const lineage = await dispatch.lineage();

      expect(recordedArgv()).toEqual(["agent", "ls", "--json", "--include-retired"]);
      expect(lineage.rows.map((agent) => agent.agentId)).toContain(retiredFirst.agentId);
      expect(reviewer && provablyIndependent(reviewer, "impl-a", lineage)).toBe(false);
    });

    it("proves nothing, and still reads the roster, on an agent-chat that predates --include-retired", async () => {
      const dispatch = brokerOf(rows.filter((agent) => agent !== retiredFirst), true);
      const reviewer = (await dispatch.roster()).find((agent) => agent.name === "rv-demo-7");
      const lineage = await dispatch.lineage();

      expect(lineage.complete).toBe(false);
      expect(reviewer && provablyIndependent(reviewer, "impl-a", lineage)).toBe(false);
    });
  });

  it("reports no working directory for a row whose cwd is empty", async () => {
    const [found] = await rosterOf([{ ...row, cwd: "" }]);

    expect(found).not.toHaveProperty("cwd");
  });

  it("reports no profile for a row whose profile is empty", async () => {
    const [found] = await rosterOf([{ ...row, profile: "" }]);

    expect(found).not.toHaveProperty("profile");
  });

  it("reports an unreachable broker as broker-down, so the caller asks again", async () => {
    const error = await failure(dispatchOver(BROKER_DOWN).roster());

    expect(error).toBeInstanceOf(ReviewerBrokerDown);
    expect(errorMessage(error)).toContain(BROKER_DOWN_LINE);
  });

  it("reports the no-autostart probe's refusal of agent ls as broker-down, not a refused dispatch (TP-4641)", async () => {
    const error = await failure(dispatchOver(`echo '${NO_AUTOSTART_LINE}' >&2\nexit 1\n`).roster());

    expect(error).toBeInstanceOf(ReviewerBrokerDown);
  });

  it("keeps a failed roster read that is not a broker outage a plain failure", async () => {
    const error = await failure(dispatchOver(`echo 'the log is locked'\nexit 1\n`).roster());

    expectRefusal(error, "the log is locked");
  });

  it("reports a roster read that outlasts its timeout as a timed-out ask, not a broker outage", async () => {
    const error = await failure(dispatchOver("exec sleep 5\n", { rosterTimeoutMs: 200 }).roster());

    expect(error).toBeInstanceOf(ReviewerAskTimedOut);
    expectRefusal(error, "timed out");
  });

  it("reports the broker's own reply timeout on a roster read as a timed-out ask", async () => {
    const error = await failure(
      dispatchOver('echo "broker did not answer agents_result" >&2\nexit 1\n').roster(),
    );

    expect(error).toBeInstanceOf(ReviewerAskTimedOut);
  });
});

describe("agentChatReviewerDispatch spawn", () => {
  it("starts the reviewer under the configured profile in the repo's checkout, with the brief on stdin and not in argv", async () => {
    const repos: string[] = [];
    const dispatch = dispatchOver(undefined, { cwdFor: (repo) => (repos.push(repo), checkout) });

    await dispatch.spawn("rv-demo-7", BRIEF, target);

    expect(recordedArgv()).toEqual(["agent", "spawn", "rv-demo-7", PROFILE, "--launched-by", "shepherd", "--brief-stdin"]);
    expect(recorded("argv")).not.toContain("SENTINEL");
    expect(recorded("stdin")).toBe(BRIEF);
    expect(recorded("cwd").trim()).toBe(checkout);
    expect(repos).toEqual(["octo/demo"]);
  });

  it("spawns a security PR and a correctness PR under different profiles", async () => {
    const dispatch = dispatchOver(undefined, { roles: { g10: "bd-reviewer", standard: "reviewer" } });

    await dispatch.spawn("rv-demo-7", BRIEF, target, { kind: "security" });
    expect(recordedArgv()[3]).toBe("bd-reviewer");
    await dispatch.spawn("rv-demo-8", BRIEF, target, { kind: "correctness" });
    expect(recordedArgv()[3]).toBe("reviewer");
  });

  it("spawns a panel member at its planned profile whatever class the PR is", async () => {
    await dispatchOver(undefined, { roles: { g10: "bd-reviewer", standard: "reviewer" } }).spawn("rv-demo-7-adversary", BRIEF, target, { kind: "security", profile: "reviewer" });

    expect(recordedArgv()[3]).toBe("reviewer");
  });

  it("spawns with whichever profile was configured", async () => {
    await dispatchOver(undefined, { roles: { g10: "rv-other", standard: "rv-other" } }).spawn("rv-demo-7", BRIEF, target);

    expect(recordedArgv()).toEqual(["agent", "spawn", "rv-demo-7", "rv-other", "--launched-by", "shepherd", "--brief-stdin"]);
  });

  it("passes the configured Claude config directory", async () => {
    await dispatchOver(undefined, { configDir: "/srv/claude-second" }).spawn("rv-demo-7", BRIEF, target);

    expect(recordedArgv()).toEqual(["agent", "spawn", "rv-demo-7", PROFILE, "--config-dir", "/srv/claude-second", "--launched-by", "shepherd", "--brief-stdin"]);
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
    expect(errorMessage(error)).toContain("octo/demo");
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
    expect(errorMessage(error)).toContain(BROKER_DOWN_LINE);
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
    expect(errorMessage(error)).toBe(reason);
  });

  it("reports a refusal agent-chat marks retryable as busy, carrying the guard's reason without the trailer", async () => {
    const guard = "machine guard: 11 live headless agents machine-wide (limit 10, config machineHeadlessAgents)";
    const error = await failure(dispatchOver(`echo 'Not spawned: ${guard}'\necho 'code: machine_headless_limit retryable: true'\nexit 1\n`).spawn("rv-demo-7", BRIEF, target));

    expect(error).toBeInstanceOf(ReviewerBrokerBusy);
    expect(errorMessage(error)).toBe(guard);
  });

  it("reports a refusal coded machine_hold as a machine hold", async () => {
    const error = await failure(dispatchOver(`echo 'Not spawned: machine stop holds: load5 34'\necho 'code: machine_hold retryable: true'\nexit 1\n`).spawn("rv-demo-7", BRIEF, target));

    expect(error).toBeInstanceOf(ReviewerMachineHold);
    expect(errorMessage(error)).toBe("machine stop holds: load5 34 (machine_hold)");
  });

  it("tells the machine-stop ledger of a machine_hold refusal and still throws the machine hold", async () => {
    const holds: string[] = [];
    const onMachineHold = (_at: number, reason: string) => void holds.push(reason);
    const error = await failure(dispatchOver(`echo 'Not spawned: machine stop holds: swap 9 GB'\necho 'code: machine_hold retryable: true'\nexit 1\n`, { onMachineHold }).spawn("rv-demo-7", BRIEF, target));

    expect(error).toBeInstanceOf(ReviewerMachineHold);
    expect(holds).toEqual(["machine stop holds: swap 9 GB (machine_hold)"]);
  });

  it("does not tell the machine-stop ledger of a plain busy refusal", async () => {
    const holds: string[] = [];
    const onMachineHold = (_at: number, reason: string) => void holds.push(reason);
    const error = await failure(dispatchOver(`echo 'Not spawned: spawn budget spent'\necho 'code: spawn_rate retryable: true'\nexit 1\n`, { onMachineHold }).spawn("rv-demo-7", BRIEF, target));

    expect(error).toBeInstanceOf(ReviewerBrokerBusy);
    expect(holds).toEqual([]);
  });

  it("keeps a machine guard refusal coded machine_headless_limit plain busy, not a machine hold", async () => {
    const guard = "machine guard: 11 live headless agents machine-wide (limit 10, config machineHeadlessAgents)";
    const error = await failure(dispatchOver(`echo 'Not spawned: ${guard}'\necho 'code: machine_headless_limit retryable: true'\nexit 1\n`).spawn("rv-demo-7", BRIEF, target));

    expect(error).toBeInstanceOf(ReviewerBrokerBusy);
    expect(error).not.toBeInstanceOf(ReviewerMachineHold);
  });

  it("reports any other refusal marked retryable as busy, naming its code", async () => {
    const error = await failure(dispatchOver(`echo 'Not spawned: spawn budget spent'\necho 'code: spawn_rate retryable: true'\nexit 1\n`).spawn("rv-demo-7", BRIEF, target));

    expect(error).toBeInstanceOf(ReviewerBrokerBusy);
    expect(errorMessage(error)).toBe("spawn budget spent (spawn_rate)");
  });

  it("keeps a refusal marked retryable: false a refusal", async () => {
    const error = await failure(dispatchOver(`echo 'Not spawned: the name rv-demo-7 is held'\necho 'code: name_held retryable: false'\nexit 1\n`).spawn("rv-demo-7", BRIEF, target));

    expect(error).not.toBeInstanceOf(ReviewerBrokerBusy);
    expectRefusal(error, "the name rv-demo-7 is held");
  });

  it("keeps a refusal that only mentions the machine guard mid-sentence a refusal", async () => {
    const error = await failure(dispatchOver(`echo 'Not spawned: no machine guard: reading'\nexit 1\n`).spawn("rv-demo-7", BRIEF, target));

    expect(error).not.toBeInstanceOf(ReviewerBrokerBusy);
    expectRefusal(error, "no machine guard");
  });

  it("reports a spawn that timed out as a timed-out ask, not a broker outage, because the reviewer may be running", async () => {
    const error = await failure(dispatchOver("exec sleep 5\n", { spawnTimeoutMs: 200 }).spawn("rv-demo-7", BRIEF, target));

    expect(error).toBeInstanceOf(ReviewerAskTimedOut);
    expectRefusal(error, "timed out");
  });

  it("refuses when the agent-chat executable is missing", async () => {
    const dispatch = agentChatReviewerDispatch({ agentChatBin: join(dir, "absent"), roles: { g10: PROFILE, standard: PROFILE }, cwdFor: () => checkout });

    expectRefusal(await failure(dispatch.spawn("rv-demo-7", BRIEF, target)), "not found");
  });

  describe("with the default spawn timeout", () => {
    /** A broker that answers after `ms`; execFile kills a child still running at its `timeout` option, as here. */
    const brokerAnsweringAfter = (ms: number): void => {
      execFileHook.override = (_bin, _args, { timeout }, done) => {
        const killed = ms > timeout;
        setTimeout(() => done(killed ? Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }) : null, "", ""), Math.min(ms, timeout));
        return { stdin: { on: () => undefined, end: () => undefined } };
      };
    };

    afterEach(() => {
      vi.useRealTimers();
      execFileHook.override = undefined;
    });

    it("lets a broker that answers after 45 s finish the spawn", async () => {
      vi.useFakeTimers();
      brokerAnsweringAfter(45_000);

      const spawned = dispatchOver().spawn("rv-demo-7", BRIEF, target);
      await vi.advanceTimersByTimeAsync(45_000);

      await expect(spawned).resolves.toBeUndefined();
    });

    it("maps a broker that hangs past 90 s to a timed-out ask", async () => {
      vi.useFakeTimers();
      brokerAnsweringAfter(10 * 60_000);

      const outcome = failure(dispatchOver().spawn("rv-demo-7", BRIEF, target));
      await vi.advanceTimersByTimeAsync(90_000);

      expect(await outcome).toBeInstanceOf(ReviewerAskTimedOut);
    });
  });
});

describe("agentChatReviewerDispatch resume", () => {
  it("resumes the named agent through agent-chat with the brief as its next message", async () => {
    await dispatchOver().resume("rv-standing", BRIEF);

    expect(recordedArgv()).toEqual(["agent", "resume", "rv-standing", "--message", BRIEF, "--launched-by", "shepherd"]);
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

  it("reports a resume that timed out as a timed-out ask, not a broker outage", async () => {
    const error = await failure(dispatchOver("exec sleep 5\n", { spawnTimeoutMs: 200 }).resume("rv-standing", BRIEF));

    expect(error).toBeInstanceOf(ReviewerAskTimedOut);
    expectRefusal(error, "timed out");
  });
});

describe("agentChatReviewerDispatch reviewer-slot reading", () => {
  const live = (name: string) => ({ name, agentId: name, state: "running", presence: "live", status: "working", profile: PROFILE, surface: "headless", cwd: "/srv/demo", sessionId: `s-${name}`, generation: 1 });
  const gateAt = (at: number) => spawnGate({ read: () => ({ load5: 0 }), now: () => at, log: () => undefined });

  it("keeps the names of the live rv- rows a spawn read, beside the concurrent cap", async () => {
    const gate = gateAt(Date.parse("2026-10-13T12:00:00Z"));
    const rows = [live("rv-demo-1"), live("rv-demo-2"), live("coord"), { ...live("rv-demo-3"), presence: "exited" }];
    const dispatch = dispatchOver(undefined, { gate, roster: createRosterReader(async () => rows) });

    await dispatch.spawn("rv-demo-7", BRIEF, target);

    expect(gate.reviewSlots()).toEqual({ running: ["rv-demo-1", "rv-demo-2"], cap: 3, readAt: "2026-10-13T12:00:00.000Z" });
  });

  it("stops waiting in the gate's queue, starting nobody, once the step's signal aborts", async () => {
    const gate = spawnGate({ read: () => ({ load5: 30 }), log: () => undefined });
    const dispatch = dispatchOver(undefined, { gate, roster: createRosterReader(async () => []) });
    const step = new AbortController();
    const cancelled = new Error("cancelled");

    const spawned = failure(dispatch.spawn("rv-demo-7", BRIEF, target, {}, step.signal));
    const resumed = failure(dispatch.resume("rv-demo-8", BRIEF, step.signal));
    step.abort(cancelled);

    expect(await spawned).toBe(cancelled);
    expect(await resumed).toBe(cancelled);
  });

  it("keeps a roster timeout as rosterError with no running list, so it never reads as 0", async () => {
    const gate = gateAt(Date.parse("2026-10-13T12:00:00Z"));
    gate.noteReviewers({ running: ["rv-demo-1"] });
    const dispatch = dispatchOver(undefined, { gate, roster: createRosterReader(async () => Promise.reject(new Error("agent ls timed out after 10000 ms"))) });

    await failure(dispatch.spawn("rv-demo-7", BRIEF, target));

    expect(gate.reviewSlots()).toStrictEqual({ cap: 3, readAt: "2026-10-13T12:00:00.000Z", rosterError: "agent ls timed out after 10000 ms" });
  });
});

describe("runningReviewStarts", () => {
  const NOW = 10_000_000;
  const rv = (name: string, over: Partial<ReviewerRosterRow> = {}): ReviewerRosterRow => ({
    name, agentId: name, sessionId: "s", presence: "live", spawnedBy: null, transcriptPath: null, transcriptExists: false, ...over,
  });

  it("counts a detached reviewer with no transcript write as not running", () => {
    expect(runningReviewStarts([rv("rv-demo-1", { presence: "detached" })], new Map(), NOW)).toEqual([]);
  });

  it("counts a detached reviewer whose transcript was last written over 15 minutes ago as not running", () => {
    const stale = rv("rv-demo-1", { presence: "detached", lastWrittenAt: NOW - 15 * 60_000 - 1 });
    expect(runningReviewStarts([stale], new Map(), NOW)).toEqual([]);
  });

  it("counts a live reviewer, and a detached one written recently, from when each was first seen", () => {
    const seen = new Map([["rv-demo-1", NOW - 600_000]]);
    const rows = [rv("rv-demo-1"), rv("rv-demo-2", { presence: "detached", lastWrittenAt: NOW - 60_000 }), rv("coord"), rv("rv-demo-3", { presence: "exited" })];

    expect(runningReviewStarts(rows, seen, NOW)).toEqual([NOW - 600_000, NOW]);
  });

  it("forgets a reviewer that no longer runs", () => {
    const seen = new Map([["rv-demo-1", NOW - 600_000]]);
    runningReviewStarts([], seen, NOW);
    expect(seen.size).toBe(0);
  });
});
