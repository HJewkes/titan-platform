import { invokeCommand } from "@titan-design/registry";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveConfig } from "../config.js";
import { createMinerContext, type MinerContext } from "../context.js";
import { playbookAdd } from "./playbook.js";
import { playbookShow, type PlaybookShowResponse } from "./playbook-show.js";

let dir: string;
let ctx: MinerContext;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-playbook-show-"));
  ctx = createMinerContext(resolveConfig({ stateDir: path.join(dir, "state"), corpusRoot: path.join(dir, "corpus") }, {}), {});
});

afterEach(() => {
  ctx.close();
  rmSync(dir, { recursive: true, force: true });
});

async function show(id: string): Promise<{ envelope: { data?: PlaybookShowResponse }; exitCode: number }> {
  const { envelope, exitCode } = await invokeCommand(playbookShow, { id }, ctx);
  return { envelope: { data: envelope.ok ? z.custom<PlaybookShowResponse>().parse(envelope.data) : undefined }, exitCode };
}

describe("playbook.show", () => {
  it("shows a rule added with session provenance and its two feedback events", async () => {
    await invokeCommand(playbookAdd, { content: "Rerun the suite before blaming the test", session: "ghost" }, ctx);
    const bullet = ctx.playbook().list()[0]!;
    ctx.playbook().recordFeedback(bullet.id, "helpful", { at: "2026-07-01T00:00:00.000Z", sessionRef: "session:a", reason: "saved a rerun" });
    ctx.playbook().recordFeedback(bullet.id, "harmful", { at: "2026-07-02T00:00:00.000Z", sessionRef: "session:b", reason: "misled" });

    const { envelope, exitCode } = await show(bullet.id);

    expect(exitCode).toBe(0);
    expect(envelope.data).toMatchObject({
      id: bullet.id,
      content: "Rerun the suite before blaming the test",
      maturity: "candidate",
      state: "active",
      helpfulCount: 1,
      harmfulCount: 1,
      sourceSessions: [{ sessionRef: "session:ghost" }],
      feedback: [
        { type: "helpful", at: "2026-07-01T00:00:00.000Z", sessionRef: "session:a", reason: "saved a rerun" },
        { type: "harmful", at: "2026-07-02T00:00:00.000Z", sessionRef: "session:b", reason: "misled" },
      ],
      replacedBy: null,
      supersededBy: [],
    });
    expect(envelope.data!.effectiveScore).toBeTypeOf("number");
  });

  it("still shows a retired rule and links it to its successor, and the successor back", async () => {
    const store = ctx.playbook();
    const old = store.add({ content: "Pin the npm major in release jobs" });
    const next = store.add({ content: "Pin the npm major and the node major in release jobs" });
    store.deprecate(old.id, "replaced by a broader rule", next.id);

    const retired = (await show(old.id)).envelope.data!;
    expect(retired).toMatchObject({ state: "retired", maturity: "deprecated", replacedBy: next.id, deprecationReason: "replaced by a broader rule" });

    const successor = (await show(next.id)).envelope.data!;
    expect(successor.supersededBy).toEqual([old.id]);
  });

  it("exits NOINPUT for an unknown id", async () => {
    expect((await show("nope")).exitCode).toBe(66);
  });
});
