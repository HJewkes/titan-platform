import { appendFileSync, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
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
const CHORE_FLAG = "--chore";
const send = (message: ChildMessage): void => void process.send?.(message);

const { serveChildPathsSchema } = await import("./serve-child.js");
const paths = serveChildPathsSchema.parse(JSON.parse(process.argv[2] ?? "{}"));
const { runChoreSpec, postMergeRoute } = await import("../workflows/post-merge.js");
/** Started again as a post-merge chore's wrapper, the fixture runs the chore instead of a serve. */
if (process.argv[3] === CHORE_FLAG) {
  await runChoreSpec(process.argv[4] ?? "");
  process.exit(0);
}
const { silentLogger } = await import("@titan-design/daemon");
const { defineWorkflow } = await import("../definition.js");
const { startFactoryServer } = await import("../serve.js");
const { systemChorePorts } = await import("../workflows/post-merge-chore.js");

const blocking = defineWorkflow({
  name: "resume-test",
  steps: [{ id: "block", kind: "dispatch" }],
  run: async (ctx) => {
    await ctx.dispatch("block", "wait for the release file");
  },
});

/** Lands nothing: the run goes straight to a post-merge chore that blocks on the release file, like `blocking`'s step. */
const chore = defineWorkflow({
  name: "chore-test",
  steps: [{ id: "post-merge", kind: "dispatch" }],
  run: async (ctx) => {
    await ctx.dispatch("post-merge", JSON.stringify({ repo: "octo/demo", pr: 1, mergeSha: null }));
  },
});

/** The chore logs itself as a dispatch, so the test counts chore launches across both serves; it gives up after 30 s. */
const CHORE_SCRIPT = `
const fs = require("node:fs");
const [log, release] = process.argv.slice(1);
fs.appendFileSync(log, JSON.stringify({ pid: process.pid, attempt: 0 }) + "\\n");
const deadline = Date.now() + 30_000;
const poll = () => (fs.existsSync(release) || Date.now() > deadline ? process.exit(0) : setTimeout(poll, 20));
poll();`;

const choreWrapper: [string, ...string[]] = [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url), JSON.stringify(paths), CHORE_FLAG];
const routes: StepRoute[] = [
  { match: "block", onRestart: "repeat", runner: { run: (input) => blockUntilReleased(input) } },
  postMergeRoute({
    postMerge: { argv: [process.execPath, "-e", CHORE_SCRIPT, paths.dispatchLog, paths.releaseFile] },
    chores: { ...systemChorePorts({ dir: `${paths.stateDir}/chores`, wrapper: choreWrapper, systemd: false }), pollMs: POLL_MS },
  }),
];

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
  workflows: [blocking, chore],
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
  if (message.kind === "start") send({ kind: "started", runId: server.host.runtime.start(message.workflow ?? blocking.name) });
  if (message.kind === "status") send({ kind: "status", status: server.host.runtime.status(message.runId)?.status ?? null });
});

process.once("SIGTERM", () => {
  void server.close().then(() => process.exit(0));
});

send({ kind: "ready", port: server.port });
