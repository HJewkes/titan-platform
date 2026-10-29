import { describe, expect, it } from "vitest";
import { reapOwnLaunch, type ProcessTable } from "./index.js";

interface FakeProc {
  env: Record<string, string> | undefined;
  command: string;
  ppid?: number;
  sid?: number;
  ignoresTerm?: boolean;
}

class FakeTable implements ProcessTable {
  readonly signals: Array<[number, string]> = [];
  constructor(readonly procs: Map<number, FakeProc>) {}
  pids = () => [...this.procs.keys()];
  environ = (pid: number) => this.procs.get(pid)?.env;
  command = (pid: number) => this.procs.get(pid)?.command ?? "";
  parentOf = (pid: number) => this.procs.get(pid)?.ppid;
  sessionOf = (pid: number) => this.procs.get(pid)?.sid;
  isAlive = (pid: number) => this.procs.has(pid);
  signal(pid: number, signal: "SIGTERM" | "SIGKILL") {
    this.signals.push([pid, signal]);
    if (signal === "SIGKILL" || !this.procs.get(pid)?.ignoresTerm) this.procs.delete(pid);
  }
}

const launch = (agentId: string, launcher: number) => ({
  AGENT_CHAT_AGENT_ID: agentId,
  AGENT_CHAT_NAME: "worker",
  AGENT_CHAT_LAUNCHER_PID: String(launcher),
});
const table = (entries: Record<number, FakeProc>) =>
  new FakeTable(new Map(Object.entries(entries).map(([pid, p]) => [Number(pid), p])));
const noSleep = { sleepSync: () => undefined, platform: "linux" as const, kill: true };

describe("reaping the processes an exiting run-agent leaves behind", () => {
  it("kills an orphan that carries the exited launch identity", () => {
    const t = table({
      100: { env: launch("a1", 100), command: "agent-chat run-agent a1" },
      201: { env: launch("a1", 100), command: "yes", ppid: 1 },
      202: { env: launch("a1", 100), command: "bash -c until grep x; do :; done", ppid: 1 },
    });
    const events: Array<[string, Record<string, unknown>]> = [];

    const report = reapOwnLaunch("a1", 100, { table: t, log: (e, d) => events.push([e, d]), ...noSleep });

    expect(report).toMatchObject({ count: 2, survivors: [] });
    expect(t.pids()).toEqual([100]);
    expect(events[0]?.[0]).toBe("orphans_reaped");
    expect(events[0]?.[1]).toMatchObject({ count: 2, commands: ["yes", "bash -c until grep x; do :; done"] });
  });

  it("leaves a live successor with the same name and a different launcher", () => {
    const t = table({
      100: { env: launch("a1", 100), command: "agent-chat run-agent a1" },
      300: { env: launch("a1", 999), command: "claude" },
      301: { env: launch("a2", 100), command: "claude" },
    });
    reapOwnLaunch("a1", 100, { table: t, log: () => undefined, ...noSleep });
    expect(t.pids().sort()).toEqual([100, 300, 301]);
  });

  it("leaves a process without the identity variable", () => {
    const t = table({ 400: { env: { PATH: "/bin" }, command: "yes" } });
    reapOwnLaunch("a1", 100, { table: t, log: () => undefined, ...noSleep });
    expect(t.signals).toEqual([]);
  });

  it("skips a process whose environ is unreadable", () => {
    const t = table({ 500: { env: undefined, command: "yes" } });
    reapOwnLaunch("a1", 100, { table: t, log: () => undefined, ...noSleep });
    expect(t.signals).toEqual([]);
  });

  it("leaves the MCP server and the caller alone", () => {
    const t = table({
      100: { env: launch("a1", 100), command: "agent-chat run-agent a1" },
      600: { env: launch("a1", 100), command: "node /x/cli.js mcp" },
    });
    reapOwnLaunch("a1", 100, { table: t, log: () => undefined, ...noSleep });
    expect(t.signals).toEqual([]);
  });

  it("leaves the broker and other agents' launchers that merely inherited the identity", () => {
    const t = table({
      100: { env: launch("a1", 100), command: "agent-chat run-agent a1" },
      900: { env: launch("a1", 100), command: "node /x/dist/cli.js broker", ppid: 1 },
      901: { env: launch("a1", 100), command: "node /x/dist/cli.js run-agent b", ppid: 1 },
      902: { env: launch("a1", 100), command: "yes", ppid: 1 },
    });
    reapOwnLaunch("a1", 100, { table: t, log: () => undefined, ...noSleep });
    expect(t.pids().sort()).toEqual([100, 900, 901]);
  });

  it("leaves daemons that inherited the identity, and still reaps a plain background burner", () => {
    const t = table({
      100: { env: launch("a1", 100), command: "agent-chat run-agent a1" },
      910: { env: launch("a1", 100), command: "tmux: server (/tmp/tmux-1/default)", ppid: 1, sid: 910 },
      911: { env: launch("a1", 100), command: "titan-factory serve", ppid: 1, sid: 5 },
      912: { env: launch("a1", 100), command: "some-daemon", ppid: 1, sid: 912 },
      914: { env: launch("a1", 100), command: "zsh -c 'while :; do :; done'", ppid: 1, sid: 914 },
      913: { env: launch("a1", 100), command: "yes", ppid: 1, sid: 5 },
    });
    reapOwnLaunch("a1", 100, { table: t, log: () => undefined, ...noSleep });
    expect(t.pids().sort()).toEqual([100, 910, 911, 912]);
  });

  it("sends TERM first, then KILL only to what survived, and reports what outlives both", () => {
    const t = table({
      700: { env: launch("a1", 100), command: "polite" },
      701: { env: launch("a1", 100), command: "stubborn", ignoresTerm: true },
    });
    const slept: number[] = [];

    const report = reapOwnLaunch("a1", 100, {
      table: t,
      log: () => undefined,
      platform: "linux",
      sleepSync: ms => void slept.push(ms),
      kill: true,
    });

    expect(t.signals).toEqual([
      [700, "SIGTERM"],
      [701, "SIGTERM"],
      [701, "SIGKILL"],
    ]);
    expect(slept).toHaveLength(1);
    expect(report?.survivors).toEqual([]);
  });

  it("only logs the exit reap, and signals nothing, unless killing is on", () => {
    const t = table({ 1: { env: launch("a1", 100), command: "pnpm storybook", sid: 5 } });
    const events: string[] = [];
    reapOwnLaunch("a1", 100, { table: t, log: e => events.push(e), ...noSleep, kill: false });
    expect(events).toEqual(["orphans_would_reap"]);
    expect(t.signals).toEqual([]);
  });

  it("is a logged no-op without /proc", () => {
    const t = table({ 800: { env: launch("a1", 100), command: "yes" } });
    const events: string[] = [];
    reapOwnLaunch("a1", 100, {
      table: t,
      log: e => events.push(e),
      sleepSync: () => undefined,
      platform: "darwin",
      kill: true,
    });
    expect(t.signals).toEqual([]);
    expect(events).toEqual(["orphan_reap_skipped"]);
  });
});
