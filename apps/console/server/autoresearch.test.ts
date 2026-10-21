import { afterEach, describe, expect, it } from "vitest";
import { EXIT, createRegistry, invokeCommand, type BaseContext } from "@titan-design/registry";
import { autoresearchCommands, autoresearchReader } from "./autoresearch.js";
import { closedPort, startFakeDaemon, type FakeDaemon, type RpcAnswer } from "./test-support.js";
import { AR_RUN_FIXTURE, AR_RUN_SUMMARY } from "./twin/autoresearch.js";

let factory: FakeDaemon | undefined;
afterEach(async () => {
  await factory?.close();
  factory = undefined;
});

/** Stands in for titan-factory's autoresearch read model (gap G14), answering the request shapes of design §3.1. */
async function serve(rpc: RpcAnswer): Promise<number> {
  factory = await startFakeDaemon({ ok: true }, rpc);
  return factory.port;
}

type AutoresearchCommand = "autoresearch.runs" | "autoresearch.run" | "autoresearch.diff";

function invoke(name: AutoresearchCommand, port: number, args: Record<string, unknown> = {}) {
  const registry = createRegistry<BaseContext>();
  for (const command of Object.values(autoresearchCommands(autoresearchReader(port)))) registry.register(command);
  return invokeCommand(registry.get(name)!, args, { warnings: [], format: "json" });
}

const DIFF = { stat: { files: 2, insertions: 14, deletions: 3 }, patch: "diff --git a/src/gate.ts b/src/gate.ts\n", truncated: false };

describe("autoresearch reader", () => {
  it("asks the factory for each read with the design's arguments", async () => {
    const asked: unknown[] = [];
    const port = await serve((command, args) => {
      asked.push({ command, args });
      if (command === "autoresearch.runs") return [AR_RUN_SUMMARY];
      if (command === "autoresearch.run") return AR_RUN_FIXTURE;
      return DIFF;
    });
    const reader = autoresearchReader(port);

    const runs = await reader.runs();
    const run = await reader.run("ar-7c1e");
    const diff = await reader.diff("ar-7c1e", "i-3f9a0c1d2e4b");

    expect(asked).toEqual([
      { command: "autoresearch.runs", args: {} },
      { command: "autoresearch.run", args: { runId: "ar-7c1e" } },
      { command: "autoresearch.diff", args: { runId: "ar-7c1e", ideaId: "i-3f9a0c1d2e4b" } },
    ]);
    expect(runs).toEqual([AR_RUN_SUMMARY]);
    expect(run).toEqual(AR_RUN_FIXTURE);
    expect(diff).toEqual(DIFF);
  });

  it("strips fields the page does not pin, at the top and inside a ladder", async () => {
    const [first, ...rest] = AR_RUN_FIXTURE.rounds;
    const ladder = { ...first!.ladders[0]!, implementer: { agent: "impl-1", sessionId: "s-1" } };
    const extended = { ...AR_RUN_FIXTURE, stepResults: [{ stepId: "ar-pin" }], rounds: [{ ...first!, ladders: [ladder, ...first!.ladders.slice(1)] }, ...rest] };
    const port = await serve((command) => (command === "autoresearch.runs" ? [{ ...AR_RUN_SUMMARY, rawConfig: { lanes: 3 } }] : extended));
    const reader = autoresearchReader(port);

    expect(await reader.run("ar-7c1e")).toEqual(AR_RUN_FIXTURE);
    expect(await reader.runs()).toEqual([AR_RUN_SUMMARY]);
  });

  it("refuses a run row missing its status as schema drift", async () => {
    const row: Record<string, unknown> = { ...AR_RUN_SUMMARY };
    delete row.status;
    const port = await serve(() => [row]);

    await expect(autoresearchReader(port).runs()).rejects.toMatchObject({ message: "factory autoresearch.runs answered an unexpected shape", code: EXIT.SOFTWARE });
  });

  it("carries the factory's own error for a run it does not hold", async () => {
    const port = await serve(() => {
      throw new Error("no autoresearch run ar-0000");
    });

    await expect(autoresearchReader(port).run("ar-0000")).rejects.toMatchObject({ message: "factory autoresearch.run: no autoresearch run ar-0000", code: EXIT.USAGE });
  });
});

describe("the console's autoresearch commands", () => {
  it("answer an unavailable error envelope when the factory is down, never an empty list", async () => {
    const { envelope, exitCode } = await invoke("autoresearch.runs", await closedPort());

    expect(envelope.ok).toBe(false);
    expect(exitCode).toBe(EXIT.UNAVAILABLE);
  });

  it("answer an error envelope when the factory refuses the read", async () => {
    const port = await serve(() => {
      throw Object.assign(new Error("autoresearch read model is not built"), { code: EXIT.SOFTWARE });
    });

    const { envelope } = await invoke("autoresearch.runs", port);

    expect(envelope).toMatchObject({ ok: false, error: "factory autoresearch.runs: autoresearch read model is not built" });
  });

  it("serve one run and one diff through the registry", async () => {
    const port = await serve((command) => (command === "autoresearch.run" ? AR_RUN_FIXTURE : DIFF));

    const run = await invoke("autoresearch.run", port, { runId: "ar-7c1e" });
    const diff = await invoke("autoresearch.diff", port, { runId: "ar-7c1e", ideaId: "i-3f9a0c1d2e4b" });

    expect(run.envelope).toMatchObject({ ok: true, data: AR_RUN_FIXTURE });
    expect(diff.envelope).toMatchObject({ ok: true, data: DIFF });
  });

  it("refuse a diff that names no idea before calling the factory", async () => {
    const asked: string[] = [];
    const port = await serve((command) => {
      asked.push(command);
      return DIFF;
    });

    const { envelope } = await invoke("autoresearch.diff", port, { runId: "ar-7c1e" });

    expect(envelope.ok).toBe(false);
    expect(asked).toEqual([]);
  });
});
