import { appendFileSync, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import type { StepRoute, StepRunOutcome } from "@titan-design/workflow";
import type { ChildMessage, Dispatch, ParentMessage } from "./serve-child.js";

/**
 * A serve child forked by `forkServeChild`. Node strips the source's types, and this hook points the
 * source's `.js` specifiers at their `.ts` files, so the child runs the same code vitest tests.
 */
registerHooks({
  resolve: (specifier, context, nextResolve) => nextResolve(sourceSibling(specifier, context.parentURL), context),
});

function sourceSibling(specifier: string, parentURL: string | undefined): string {
  const fromSource = parentURL?.startsWith("file:") === true && parentURL.endsWith(".ts");
  return fromSource && specifier.startsWith(".") && specifier.endsWith(".js") ? `${specifier.slice(0, -3)}.ts` : specifier;
}

const LEASE_MS = 1_000;
const POLL_MS = 20;
const send = (message: ChildMessage): void => void process.send?.(message);

const { serveChildPathsSchema } = await import("./serve-child.js");
const paths = serveChildPathsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const { silentLogger } = await import("@titan-design/daemon");
const { defineWorkflow } = await import("../definition.js");
const { startFactoryServer } = await import("../serve.js");

const blocking = defineWorkflow({
  name: "resume-test",
  steps: [{ id: "block", kind: "dispatch" }],
  run: async (ctx) => {
    await ctx.dispatch("block", "wait for the release file");
  },
});

const routes: StepRoute[] = [{ match: "block", onRestart: "repeat", runner: { run: (input) => blockUntilReleased(input) } }];

/** `restarts` is read loosely: the field arrives with TP-2675, and the log records it once it does. */
async function blockUntilReleased(input: Parameters<StepRoute["runner"]["run"]>[0]): Promise<StepRunOutcome> {
  const restarts = "restarts" in input && typeof input.restarts === "number" ? input.restarts : undefined;
  const dispatch: Dispatch = { pid: process.pid, attempt: input.attempt, restarts };
  appendFileSync(paths.dispatchLog, `${JSON.stringify(dispatch)}\n`);
  while (!existsSync(paths.releaseFile)) {
    if (input.signal.aborted) return { ok: false, error: "aborted", retryable: true };
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return { ok: true, output: "released" };
}

const server = await startFactoryServer({
  dbPath: paths.dbPath,
  stateDir: paths.stateDir,
  deployStateDir: paths.stateDir,
  workflows: [blocking],
  routes,
  port: 0,
  leaseMs: LEASE_MS,
  gatePollMs: POLL_MS,
  logger: silentLogger,
  github: { status: () => "ok", refresh: async () => undefined },
  build: { sha: "test", behindMain: { status: () => 0, refresh: async () => undefined } },
  ownerKeys: () => ({ ok: false, refusal: "serve child has no owner keys" }),
  onEvent: (event) => send({ kind: "event", event }),
});

process.on("message", (message: ParentMessage) => {
  if (message.kind === "start") send({ kind: "started", runId: server.host.runtime.start(blocking.name) });
  if (message.kind === "status") send({ kind: "status", status: server.host.runtime.status(message.runId)?.status ?? null });
});

process.once("SIGTERM", () => {
  void server.close().then(() => process.exit(0));
});

send({ kind: "ready", port: server.port });
