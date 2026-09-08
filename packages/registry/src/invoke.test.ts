import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EXIT } from "./envelope.js";
import { invokeCommand } from "./invoke.js";
import { defineCommand, type BaseContext } from "./types.js";

interface Ctx extends BaseContext {
  root: string;
}

const ctx = (): Ctx => ({ warnings: [], format: "json", root: "/tmp" });

const echo = defineCommand<{ n: number }, { doubled: number; root: string }, Ctx>({
  name: "echo",
  description: "double a number",
  args: z.object({ n: z.number() }),
  result: z.object({ doubled: z.number(), root: z.string() }),
  async run(args, c) {
    if (args.n < 0) c.warnings.push("negative input");
    return { doubled: args.n * 2, root: c.root };
  },
});

class Missing extends Error {
  readonly code = EXIT.NOINPUT;
}

const failing = defineCommand<Record<string, never>, never, Ctx>({
  name: "fail",
  description: "always throws",
  args: z.object({}),
  result: z.never(),
  async run() {
    throw new Missing("no such thing");
  },
});

describe("invokeCommand", () => {
  it("validates, runs, and wraps the result with the product context available", async () => {
    const { envelope, exitCode } = await invokeCommand(echo, { n: 4 }, ctx());
    expect(envelope).toEqual({ ok: true, data: { doubled: 8, root: "/tmp" } });
    expect(exitCode).toBe(EXIT.OK);
  });

  it("surfaces warnings the command pushed onto the context", async () => {
    const { envelope } = await invokeCommand(echo, { n: -1 }, ctx());
    expect(envelope).toEqual({ ok: true, data: { doubled: -2, root: "/tmp" }, warnings: ["negative input"] });
  });

  it("rejects invalid args with DATAERR by default and USAGE when asked", async () => {
    const server = await invokeCommand(echo, { n: "four" }, ctx());
    expect(server.envelope).toMatchObject({ ok: false, code: EXIT.DATAERR });
    expect((server.envelope as { error: string }).error).toMatch(/^Invalid arguments: n: /);

    const cli = await invokeCommand(echo, {}, ctx(), { invalidArgsCode: EXIT.USAGE });
    expect(cli.exitCode).toBe(EXIT.USAGE);
  });

  it("treats null or undefined raw args as an empty object", async () => {
    const { envelope } = await invokeCommand(failing, undefined, ctx());
    expect(envelope).toMatchObject({ ok: false, error: "no such thing" });
  });

  it("maps thrown errors through their code without throwing", async () => {
    const { envelope, exitCode } = await invokeCommand(failing, {}, ctx());
    expect(envelope).toEqual({ ok: false, error: "no such thing", code: EXIT.NOINPUT });
    expect(exitCode).toBe(EXIT.NOINPUT);
  });

  it("uses a custom formatError when provided", async () => {
    const { envelope } = await invokeCommand(failing, {}, ctx(), {
      formatError: () => ({ message: "redacted", code: EXIT.SOFTWARE }),
    });
    expect(envelope).toEqual({ ok: false, error: "redacted", code: EXIT.SOFTWARE });
  });
});
