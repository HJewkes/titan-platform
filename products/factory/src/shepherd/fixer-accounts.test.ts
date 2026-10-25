import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRow } from "@titan-design/agent-dispatch";
import { fakeGitHub, fakeSha, githubPort, successRun } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import type { RoutedStepInput } from "@titan-design/workflow";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { isolateAgentChatHome } from "../test-support/agent-chat-home.js";
import { agentChatAgents } from "./agents.js";
import { accountLimitMigration, accountLimitStoreRef, type AccountLimitStoreRef } from "./account-store.js";
import { FreezeStore, freezeCancelOnlyMigration, freezeFixPrMigration, freezeMigration } from "./freeze.js";
import { fixersOver, spawnFixer } from "./main-red.js";
import type { ShepherdDeps } from "./phases.js";
import { repoFreezeMigration } from "./repo-freeze.js";
import { shepherdEventMigration } from "./events.js";
import { lineageMigration, shepherdMigration, shepherdStoreRef, sliceMigration } from "./store.js";
import { wakeRoutes, type ImplementerAgents } from "./wake.js";

const REPO = "octo/widget";
const RED = fakeSha("red");
const H1 = fakeSha("head-1");
const T0 = Date.parse("2026-10-10T12:00:00.000Z");
const RESETS_AT_S = Math.floor((T0 + 6 * 60 * 60_000) / 1000);
const FIRST = "/home/user/.claude-profiles/first";
const SECOND = "/home/user/.claude-profiles/second";
const SCRATCH = mkdtempSync(join(tmpdir(), "tp3962-fixer-accounts-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

function limitsWith(...exhausted: string[]): AccountLimitStoreRef {
  const db = openDatabase(":memory:");
  runMigrations(db, [accountLimitMigration(1)]);
  const ref = accountLimitStoreRef(() => T0);
  ref.bind(db);
  for (const account of exhausted) ref.get().markExhausted(account, T0 + 60 * 60_000, "usage limit reached");
  return ref;
}

function boundDeps(extra: Partial<ShepherdDeps>): { deps: ShepherdDeps; freezes: FreezeStore } {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), freezeMigration(6), sliceMigration(8), freezeCancelOnlyMigration(12), shepherdEventMigration(16), freezeFixPrMigration(23), repoFreezeMigration(33)]);
  const store = shepherdStoreRef();
  store.bind(db);
  const fake = fakeGitHub({ repo: REPO });
  fake.addPr({ headSha: H1 });
  fake.setRuns(RED, [successRun("validate", 7, undefined, "failure")]);
  fake.jobLogs.set(7, "assertion failed in widget.test");
  const deps: ShepherdDeps = { port: githubPort(fake.wire), store, now: () => T0, sleep: async () => undefined, pollMs: 1_000, agentChatBin: "agent-chat", ...extra };
  return { deps, freezes: new FreezeStore(db, () => T0) };
}

let bins = 0;
/** A fake `agent-chat` that records each spawn's argv and lists an empty roster, behind a headless profile. */
function fakeAgentChat(): { bin: string; argv: () => string[] } {
  const argvFile = join(SCRATCH, `argv-${++bins}`);
  const bin = join(SCRATCH, `agent-chat-${bins}`);
  writeFileSync(argvFile, "");
  writeFileSync(bin, `#!/bin/sh\nif [ "$2" = "spawn" ]; then for a in "$@"; do printf '%s\\0' "$a" >>"${argvFile}"; done; fi\ncat >/dev/null\nprintf '[]'\n`);
  chmodSync(bin, 0o755);
  isolateAgentChatHome(SCRATCH, ["bd-implementer"]);
  return { bin, argv: () => readFileSync(argvFile, "utf8").split("\0") };
}

describe("a red main's fixer spawn", () => {
  async function fixerArgv(extra: Partial<ShepherdDeps>): Promise<string[]> {
    const agentChat = fakeAgentChat();
    const { deps, freezes } = boundDeps(extra);
    freezes.freeze(REPO, RED);
    const wiring = { freezes: () => freezes, fixers: fixersOver(agentChatAgents(agentChat.bin)), checkoutFor: () => SCRATCH };

    const result = await spawnFixer(deps, wiring, { repo: REPO, mergeSha: RED, task: "demo/FX-1", fixer: true, episode: 1 }, new AbortController().signal);

    expect(result.detail).toBe("spawned");
    return agentChat.argv();
  }

  it("spawns under the next account in the successor rotation when the first is exhausted", async () => {
    const argv = await fixerArgv({ agentChatConfigDir: FIRST, successorAccounts: () => [FIRST, SECOND], accountLimits: limitsWith(FIRST) });

    expect(argv).toContain(SECOND);
    expect(argv).not.toContain(FIRST);
  });

  it("spawns under the fixer config directory when no rotation is wired", async () => {
    expect(await fixerArgv({ agentChatConfigDir: FIRST })).toContain(FIRST);
  });

  it("spawns under agent-chat's default account, naming no config directory, while the default has headroom", async () => {
    const argv = await fixerArgv({ successorAccounts: () => ["default", SECOND], accountLimits: limitsWith() });

    expect(argv).not.toContain("--config-dir");
  });
});

const user = (sessionId: string): object => ({ type: "user", sessionId, uuid: "user-1", timestamp: "2026-10-10T11:00:00Z", message: { role: "user", content: "fix the parser" } });
const assistant = (sessionId: string, text: string, model = "claude-test"): object => ({
  type: "assistant",
  sessionId,
  uuid: `assistant-${text.length}`,
  timestamp: "2026-10-10T11:30:00Z",
  message: { id: "msg-1", role: "assistant", model, content: [{ type: "text", text }] },
});
/** Claude Code's own record when an account runs out: its placeholder model, the API error, and the quota's reset. */
const limitNotice = (sessionId: string): object => ({
  ...assistant(sessionId, "You've hit your session limit · resets 6pm (UTC)", "<synthetic>"),
  isApiErrorMessage: true,
  error: "rate_limit",
  apiErrorStatus: 429,
  quotaLimits: { status: "rejected", resetsAt: RESETS_AT_S, rateLimitType: "five_hour" },
});

function exitedRow(name: string, account: string | null, records: readonly object[]): AgentRow {
  const sessionId = `s-${name}`;
  const transcriptPath = join(SCRATCH, "project", `${sessionId}.jsonl`);
  mkdirSync(join(SCRATCH, "project"), { recursive: true });
  writeFileSync(transcriptPath, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  return { name, agentId: `id-${name}`, state: "exited", presence: "exited", status: "finished", profile: "bd-implementer", surface: "headless", cwd: "/work/demo", sessionId, transcriptPath, transcriptExists: true, account, generation: 1 };
}

/** The wake's await-new-head step over one exited fixer, with the head unchanged, as after a fix round that pushed nothing. */
async function awaitExit(row: AgentRow, limits: AccountLimitStoreRef): Promise<void> {
  const { deps } = boundDeps({ agentChatBin: "/opt/bin/agent-chat", accountLimits: limits });
  const agents: ImplementerAgents = { roster: async () => [row], resume: async () => undefined, spawn: async () => undefined, message: async () => undefined };
  const route = wakeRoutes(deps, { agents }).find((candidate) => candidate.match === "sh-await-new-head")!;
  const prompt = JSON.stringify({ repo: REPO, pr: 1, headSha: H1, agent: row.name });
  const step: RoutedStepInput = { runId: "run-1", workflowName: "fixer-limit-test", iteration: 0, prompt, signal: new AbortController().signal, attempt: 0, requestKey: "k", stepId: "sh-await-new-head:0" };

  const outcome = await route.runner.run(step);

  expect(outcome).toMatchObject({ ok: true });
  expect(outcome.ok && JSON.parse(outcome.output)).toMatchObject({ result: { exited: true } });
}

describe("a woken fixer that exits on its account's usage limit", () => {
  it("marks the account it ran under exhausted until the notice's reset, so the next successor spawns elsewhere", async () => {
    const limits = limitsWith();

    await awaitExit(exitedRow("impl-a-s1", SECOND, [user("s-impl-a-s1"), limitNotice("s-impl-a-s1")]), limits);

    expect(limits.get().exhausted(SECOND)).toMatchObject({ resetsAt: RESETS_AT_S * 1000 });
    expect(limits.get().exhausted(FIRST)).toBeUndefined();
  });

  it("marks agent-chat's default account when the row names none", async () => {
    const limits = limitsWith();

    await awaitExit(exitedRow("impl-b", null, [user("s-impl-b"), limitNotice("s-impl-b")]), limits);

    expect(limits.get().exhausted("default")).toBeDefined();
  });

  it("marks nothing when the session ended on the fixer's own words, even ones that quote the limit", async () => {
    const limits = limitsWith();

    await awaitExit(exitedRow("impl-c", SECOND, [user("s-impl-c"), assistant("s-impl-c", "You've hit your session limit · resets 6pm (UTC)")]), limits);

    expect(limits.get().exhausted(SECOND)).toBeUndefined();
  });
});
