import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StepRoute } from "@titan-design/workflow";
import { defineWorkflow } from "../definition.js";
import { advanceEpoch } from "../head-guard/epoch-store.js";
import { openFactoryHost } from "../host.js";

const PARAMS = { repo: "Fixture/Repo", pr: "7" };
const SHA = "e".repeat(40);
const UNAVAILABLE = { unavailable: { resetAt: 1_798_000_000_000, reason: "rate-limited", class: "core-read" } };
const GREEN = { verdict: "green", headSha: SHA, mergeableState: "clean" };
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Reads CI until a read is not `Unavailable`, the way a recipe waits out a closed pool. */
const ciUntilRead = defineWorkflow({
  name: "ci-until-read",
  steps: [{ id: "ci-wait", kind: "dispatch" }],
  run: async (ctx) => {
    for (;;) {
      const read = await ctx.dispatch("ci-wait", "wait", { schema: z.looseObject({}) });
      if (!("unavailable" in read.data)) return;
    }
  },
});

/** A host whose `ci-wait` reads answer in order; each answer runs when the read is made. */
function hostAnswering(answers: Array<() => Promise<object>>) {
  const dir = mkdtempSync(join(tmpdir(), "shadow-unavailable-"));
  dirs.push(dir);
  const route: StepRoute = { match: "ci-wait", onRestart: "repeat", runner: { run: async () => ({ ok: true, output: JSON.stringify(await answers.shift()!()) }) } };
  const host = openFactoryHost({ dbPath: join(dir, "factory.sqlite3"), workflows: [ciUntilRead], routes: [route], markerShadow: { sink: () => undefined } });
  advanceEpoch(host.db, { repo: PARAMS.repo, pr: 7, expectedEpoch: 0, head: SHA, by: "bootstrap", at: "2026-11-01T12:00:00.000Z" });
  return host;
}

const markerCount = (host: ReturnType<typeof openFactoryHost>, where = "1 = 1"): number =>
  (host.db.prepare(`SELECT COUNT(*) AS n FROM factory_marker WHERE ${where}`).get() as { n: number }).n;

describe("an Unavailable step on the marker table", () => {
  it("A17: an Unavailable step writes no marker and counts no re-drive, against the marker table", async () => {
    let answerGreen: () => void = () => undefined;
    const secondRead = new Promise<void>((resolve) => (answerGreen = resolve));
    const reached = vi.fn();
    const host = hostAnswering([
      async () => UNAVAILABLE,
      async () => {
        reached();
        await secondRead;
        return GREEN;
      },
    ]);
    const before = markerCount(host);
    const id = host.runtime.start("ci-until-read", PARAMS);

    await vi.waitFor(() => expect(reached).toHaveBeenCalled());
    const afterUnavailable = markerCount(host);
    answerGreen();
    await vi.waitFor(() => expect(host.runtime.status(id)?.status).toBe("completed"));

    expect(afterUnavailable).toBe(before);
    expect(markerCount(host, "fact LIKE 'redrive:%'")).toBe(0);
    expect(markerCount(host, "fact = 'ci:green'")).toBe(1);
    host.close();
  });

  it("a step that throws Unavailable writes no marker", async () => {
    const host = hostAnswering([
      async () => {
        throw new Error("Unavailable: the core-read pool is closed");
      },
    ]);
    const id = host.runtime.start("ci-until-read", PARAMS);

    await vi.waitFor(() => expect(host.runtime.status(id)?.status).toMatch(/failed|recovery_required/));

    expect(markerCount(host)).toBe(0);
    host.close();
  });
});
