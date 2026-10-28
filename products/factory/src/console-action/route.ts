import type { Logger, StartDaemonOptions } from "@titan-design/daemon";
import type { GitHubPort } from "@titan-design/github";
import { EXIT, errorEnvelope } from "@titan-design/registry";
import { z } from "zod";
import type { FactoryHost } from "../host.js";
import { doneResults, ownerOpsLedger } from "../owner-ops/ledger.js";
import type { PauseClearPorts } from "../owner-ops/pause-clear.js";
import type { AgentChatRetirePort } from "../owner-ops/retire-agent.js";
import { standingAnswers, type StandingAnswers } from "../owner-ops/standing-answers.js";
import { readCapped, TOO_LARGE } from "../resolve-proof.js";
import type { FreezeStoreRef } from "../shepherd/freeze.js";
import type { ShepherdStoreRef } from "../shepherd/store.js";
import { resolveGate } from "./gate.js";
import { actOnOp, OP_EFFECTS, type OpDeps } from "./op.js";
import { recordPlanApproval } from "./plan-approval.js";
import { statusOf, type Outcome, type Status } from "./outcome.js";
import { readRecord } from "./record.js";
import { releaseHold } from "./release.js";

export const CONSOLE_ACTION_PATH = "/owner/console-action";
export const MAX_ACTION_BODY_BYTES = 4 * 1024;
/** The console's action id rule, so the id can never name a path outside the actions dir. */
const ACTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

type App = Parameters<NonNullable<StartDaemonOptions["mountRoutes"]>>[0];
type Answer = { body: object; status: Status };

const ActionBody = z.strictObject({ actionId: z.string().regex(ACTION_ID) });

interface ConsoleActionDeps {
  host: FactoryHost;
  /** Fresh PR reads; absent without the shepherd routes, and then the route answers 503. */
  port: GitHubPort | undefined;
  /** Shepherd's registrations, for an owner-release; absent without the shepherd routes, as `port` is. */
  store: ShepherdStoreRef | undefined;
  /** Shepherd's freezes, which stop a merge-at-head; absent means no repo is ever frozen. */
  freeze: FreezeStoreRef | undefined;
  /** The console's owner-written action records; each request reads its own record from here and nowhere else. */
  actionsDir: string;
  /** Serve's state directory, which holds the owner-ops ledger. */
  stateDir: string;
  /** The agent-chat CLI a retire-agent op runs through; absent, such an op answers 503. */
  agentChat?: AgentChatRetirePort;
  /** The deployer's state directory and its lock and pause-file ports, which a deploy-pause-clear reads and writes. */
  deploy: { stateDir: string; ports: PauseClearPorts };
  now: () => number;
  log: Logger;
}

/**
 * A console inbox tap as an owner-remote resolve of the approve-merge gate the owner confirmed, as an owner-remote release
 * of the owner-asked hold on the PR the owner confirmed, as the owner's plan-time approval of a task's scope (the only write to
 * `shepherd_plan_approval`), or as a typed owner op the authority table admits. Mounted on serve
 * through the daemon's `mountRoutes`, behind its Host, Origin, client-header and JSON guards, and kept out of the registry so it
 * is never an MCP tool or RPC command. No token: the trust boundary is the OS account, as for answer-ship. The body names only
 * the action id; what to do comes from the console's record file, and the live state must agree with it.
 */
export function mountConsoleAction(app: App, deps: ConsoleActionDeps): void {
  const ops: OpDeps = { effects: OP_EFFECTS, ledger: ownerOpsLedger(deps.stateDir), now: deps.now };
  const answers = standingAnswers(deps.stateDir);
  app.post(CONSOLE_ACTION_PATH, async (c) => {
    const answer = await consoleAction(c.req.raw, deps, ops, answers);
    if (answer.status === 413) c.header("connection", "close");
    return c.json(answer.body, answer.status);
  });
}

async function consoleAction(raw: Request, deps: ConsoleActionDeps, ops: OpDeps, answers: StandingAnswers): Promise<Answer> {
  const text = await readCapped(raw, MAX_ACTION_BODY_BYTES);
  if (text === TOO_LARGE) return failure(413, `action body over ${MAX_ACTION_BODY_BYTES} bytes`);
  const actionId = parseBody(text);
  if (actionId === undefined) return failure(400, "body must be {actionId}");
  if (deps.port === undefined || deps.store === undefined) return failure(503, "shepherd routes not mounted");
  try {
    const outcome = await acted(actionId, { ...deps, port: deps.port, store: deps.store }, ops, answers);
    deps.log.info({ actionId, ...outcome }, "answered a console action");
    return { body: outcome, status: statusOf(outcome) };
  } catch (error) {
    deps.log.error({ err: error instanceof Error ? error.message : String(error), actionId }, "answering a console action failed");
    return failure(500, "answering the console action failed");
  }
}

type Mounted = ConsoleActionDeps & { port: GitHubPort; store: ShepherdStoreRef };

async function acted(actionId: string, deps: Mounted, ops: OpDeps, answers: StandingAnswers): Promise<Outcome> {
  const { host, port, store, freeze, deploy, now, agentChat, stateDir } = deps;
  const read = await readRecord(deps.actionsDir, actionId);
  if ("outcome" in read) return read;
  if ("op" in read) return actOnOp(actionId, read, ops, { host, port, services: { store, freeze }, answers, ledger: ops.ledger, deploy, now, agentChat, done: (id) => doneResults(stateDir, id) });
  const { action, confirmEvent } = read;
  if (action.kind === "plan-approval") return recordPlanApproval({ action, confirmEvent }, store.get());
  return action.kind === "owner-release" ? releaseHold({ action, confirmEvent }, port, store.get(), host.batches) : resolveGate({ action, confirmEvent }, port, host);
}

function failure(status: Status, message: string): Answer {
  const code = status === 503 ? EXIT.UNAVAILABLE : status === 500 ? EXIT.SOFTWARE : EXIT.DATAERR;
  return { body: errorEnvelope(message, code), status };
}

function parseBody(raw: string): string | undefined {
  try {
    const parsed = ActionBody.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.actionId : undefined;
  } catch {
    return undefined;
  }
}
