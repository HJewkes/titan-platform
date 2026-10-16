import { describe, expect, it } from "vitest";
import { SETTINGS_ENTRY } from "./cli.js";
import { answerWithin, HOOK_DEADLINE_MS, remainingMs, startWorker } from "./deadline.js";
import type { Running, WithinPort } from "./deadline.js";
import type { HookResult } from "./hook.js";

const NOW = new Date("2026-01-02T03:04:05.000Z");
const BASH = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", tool_input: { command: "git status" } });
const READ = JSON.stringify({ tool_name: "Read", session_id: "s", tool_use_id: "t", tool_input: { file_path: "/tmp/notes.txt" } });
const PASS: HookResult = { stdout: "", log: [] };
const TIMEOUT = "authority-guard could not finish checking this call in time, so it was not run. Split the command into smaller Bash calls.";
/** Worker start-up, the deny and a busy CI runner. */
const MARGIN_MS = 1000;

/** A worker running `code` as an ES module, so each case exercises the real thread and its `terminate`. */
function inWorker(code: string): () => Running {
  return () => startWorker({ input: "", env: {}, home: "/tmp" }, new URL(`data:text/javascript,${encodeURIComponent(code)}`));
}

function port(start: WithinPort["start"], deadlineMs = 2000): WithinPort {
  return { env: {}, now: () => NOW, deadlineMs, start };
}

function reasonOf(result: HookResult): string | undefined {
  expect(result.stdout).toContain('"permissionDecision":"deny"');
  return /"permissionDecisionReason":"([^"]*)"/.exec(result.stdout)?.[1];
}

describe("answerWithin a check that runs past its deadline", () => {
  it("denies a check that keeps its thread busy, within the deadline plus a margin", async () => {
    const start = performance.now();

    const result = await answerWithin(BASH, port(inWorker("for (;;) {}"), 100));

    expect(performance.now() - start).toBeLessThan(100 + MARGIN_MS);
    expect(reasonOf(result)).toBe(TIMEOUT);
    expect(result.log).toHaveLength(1);
    expect(result.log[0]).toContain("\tbash.timeout\t");
  });

  it("keeps the deny when an allow arrives after the deadline", async () => {
    let answer: (r: HookResult) => void = () => undefined;
    const late = new Promise<HookResult>((resolve) => (answer = resolve));

    const result = await answerWithin(BASH, port(() => ({ result: late, stop: () => undefined }), 20));
    answer(PASS);
    await late;

    expect(reasonOf(result)).toBe(TIMEOUT);
  });

  it("denies a path event too, logging its kind", async () => {
    const result = await answerWithin(READ, port(inWorker("for (;;) {}"), 50));

    expect(reasonOf(result)).toBe(TIMEOUT);
    expect(result.log[0]).toContain("\tread.timeout\t");
  });
});

describe("answerWithin a check whose thread dies", () => {
  it.each([
    ["throws", "throw new Error('boom');"],
    ["exits without an answer", "process.exit(0);"],
    ["answers with the wrong shape", "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ stdout: 1 });"],
  ])("denies when the worker %s", async (_case, code) => {
    const result = await answerWithin(BASH, port(inWorker(code)));

    expect(reasonOf(result)).toMatch(/^authority-guard stopped before it finished checking this call/);
    expect(result.log[0]).toContain("\tbash.crash\t");
  });

  it("denies when the worker cannot start", async () => {
    const result = await answerWithin(BASH, port(() => { throw new Error("no threads"); }));

    expect(reasonOf(result)).toMatch(/^authority-guard stopped before/);
  });

  it("denies an event it cannot read, with no log line", async () => {
    const result = await answerWithin("not json", port(inWorker("throw new Error('boom');")));

    expect(reasonOf(result)).toMatch(/^authority-guard stopped before/);
    expect(result.log).toEqual([]);
  });
});

describe("answerWithin a check that finishes in time", () => {
  it.each([
    ["an allow", PASS],
    ["a deny", { stdout: '{"hookSpecificOutput":{"permissionDecision":"deny"}}', log: ["line"] }],
  ])("passes %s through unchanged", async (_case, answer) => {
    const code = `import { parentPort } from 'node:worker_threads'; parentPort.postMessage(${JSON.stringify(answer)});`;

    expect(await answerWithin(BASH, port(inWorker(code)))).toEqual(answer);
  });
});

describe("remainingMs", () => {
  it("counts down from the hook deadline on node's clock and stops at zero", () => {
    expect(remainingMs(50)).toBe(HOOK_DEADLINE_MS - 50);
    expect(remainingMs(HOOK_DEADLINE_MS + 1)).toBe(0);
  });

  it("leaves the deny 1.5 s inside the hook timeout the settings entry gives Claude Code", () => {
    expect(SETTINGS_ENTRY.hooks[0].timeout * 1000 - HOOK_DEADLINE_MS).toBeGreaterThanOrEqual(1500);
  });
});
