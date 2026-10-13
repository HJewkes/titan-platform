import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowStatus } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { dispatches, forkServeChild, releaseBlockedStep, serveChildPaths, storedOwner, type ServeChild, type ServeChildPaths } from "./test-support/serve-child.js";

const CASE_MS = 60_000;
const POLL_MS = 50;
const forked = new Set<ChildProcess>();
const dirs: string[] = [];

afterEach(async () => {
  for (const child of forked) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  forked.clear();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

function scratch(): ServeChildPaths {
  const dir = mkdtempSync(join(tmpdir(), "factory-restart-resume-"));
  dirs.push(dir);
  return serveChildPaths(dir);
}

async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`${what} not reached within ${timeoutMs} ms; last read ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Starts a run on a first serve and waits until its blocking step is dispatched there. */
async function runBlockedOnFirstServe(paths: ServeChildPaths): Promise<{ first: ServeChild; runId: string }> {
  const first = await forkServeChild(paths, forked);
  const runId = await first.start();
  await until(() => dispatches(paths).length, (count) => count === 1, 10_000, "first dispatch");
  return { first, runId };
}

/** Polls the successor until the run settles, keeping every status it read. */
async function settle(successor: ServeChild, runId: string): Promise<WorkflowStatus[]> {
  const seen: WorkflowStatus[] = [];
  await until(
    async () => {
      const status = await successor.status(runId);
      if (status && seen.at(-1) !== status) seen.push(status);
      return status;
    },
    (status) => status !== "running" && status !== null,
    20_000,
    "a settled run",
  );
  return seen;
}

function expectResumedOnce(paths: ServeChildPaths, first: ServeChild, successor: ServeChild, statuses: readonly WorkflowStatus[]): void {
  const events = [...first.events, ...successor.events];
  expect(statuses.at(-1)).toBe("completed");
  expect(statuses).not.toContain("recovery_required");
  expect(events.filter((event) => event.type === "workflow_recovery_required")).toEqual([]);
  expect(dispatches(paths).map((dispatch) => dispatch.pid)).toEqual([first.pid, successor.pid]);
}

describe("a serve stopped mid-step hands its run to the next serve", () => {
  it(
    "a serve killed with SIGKILL mid-step: the successor re-dispatches the repeat step once its lease lapses and completes the run",
    async () => {
      const paths = scratch();
      const { first, runId } = await runBlockedOnFirstServe(paths);

      await first.kill("SIGKILL");
      const successor = await forkServeChild(paths, forked);
      await until(() => dispatches(paths).length, (count) => count === 2, 10_000, "the successor's dispatch");
      releaseBlockedStep(paths);
      const statuses = await settle(successor, runId);

      expectResumedOnce(paths, first, successor, statuses);
    },
    CASE_MS,
  );

  it(
    "a serve stopped with SIGTERM mid-step releases its lease, so the successor adopts the run within 2 s and completes it",
    async () => {
      const paths = scratch();
      const { first, runId } = await runBlockedOnFirstServe(paths);

      await first.kill("SIGTERM");
      const ownerAfterStop = storedOwner(paths, runId);
      const successor = await forkServeChild(paths, forked);
      const readyAt = Date.now();
      await until(() => dispatches(paths).length, (count) => count === 2, 2_000, "adoption within 2 s");
      const adoptionMs = Date.now() - readyAt;
      releaseBlockedStep(paths);
      const statuses = await settle(successor, runId);

      expect(ownerAfterStop).toBeUndefined();
      expect(adoptionMs).toBeLessThan(2_000);
      expectResumedOnce(paths, first, successor, statuses);
    },
    CASE_MS,
  );

  it(
    "a serve killed with SIGKILL mid-chore: the post-merge chore finishes in its own process and the successor records it",
    async () => {
      const paths = scratch();
      const first = await forkServeChild(paths, forked);
      const runId = await first.start("chore-test");
      await until(() => dispatches(paths).length, (count) => count === 1, 10_000, "the chore's start");

      await first.kill("SIGKILL");
      const successor = await forkServeChild(paths, forked);
      releaseBlockedStep(paths);
      const statuses = await settle(successor, runId);

      const chores = dispatches(paths).map((dispatch) => dispatch.pid);
      expect(statuses.at(-1)).toBe("completed");
      expect(statuses).not.toContain("recovery_required");
      expect([...first.events, ...successor.events].filter((event) => event.type === "workflow_recovery_required")).toEqual([]);
      expect(chores).toHaveLength(1);
      expect(chores).not.toContain(first.pid);
    },
    CASE_MS,
  );

  it.skip(
    "a restart is counted apart from retries: the successor's dispatch sees restarts 1 (needs TP-2675)",
    async () => {
      const paths = scratch();
      const { first } = await runBlockedOnFirstServe(paths);

      await first.kill("SIGKILL");
      await forkServeChild(paths, forked);
      await until(() => dispatches(paths).length, (count) => count === 2, 10_000, "the successor's dispatch");

      expect(dispatches(paths).map((dispatch) => dispatch.restarts ?? 0)).toEqual([0, 1]);
    },
    CASE_MS,
  );
});
