import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { Logger, StartDaemonOptions } from "@titan-design/daemon";
import type { GitHubPort } from "@titan-design/github";
import { GateAlreadySettled, GateExpired, GateNotFound, GatePayloadInvalid, GateResolverRefused, type GateRecord, type GateResolver } from "@titan-design/hitl";
import { EXIT, errorEnvelope } from "@titan-design/registry";
import { z } from "zod";
import { MERGE_GATE, landGate, stepOf, type LandGate } from "./coordinator-evidence.js";
import { stepIdMatches } from "./definition.js";
import { batchRefusal } from "./gate-batch-plan.js";
import { pendingGateId } from "./gate-resolve.js";
import type { FactoryHost } from "./host.js";
import { readCapped, TOO_LARGE } from "./resolve-proof.js";
import { ownerRelease } from "./shepherd/owner-release.js";
import type { ShepherdStore, ShepherdStoreRef } from "./shepherd/store.js";

export const CONSOLE_ACTION_PATH = "/owner/console-action";
export const MAX_ACTION_BODY_BYTES = 4 * 1024;
export const MAX_ACTION_RECORD_BYTES = 64 * 1024;
/** The console's action id rule, so the id can never name a path outside the actions dir. */
const ACTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** O_NONBLOCK so a planted FIFO cannot hang the open; O_NOFOLLOW so a symlinked record is refused, not followed. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/**
 * The steps a console tap may resolve. Policy as data: an approve-merge gate at a pinned head, the Version Packages Ship under
 * `shepherd-release/*` included (314A). Hardware, after-stages and every other step stay on the terminal; hitl's rule is beneath this.
 */
const CONSOLE_STEPS: ReadonlySet<string> = Object.freeze(new Set([MERGE_GATE]));

type App = Parameters<NonNullable<StartDaemonOptions["mountRoutes"]>>[0];
type Status = 200 | 400 | 403 | 409 | 410 | 413 | 422 | 500 | 503;
type Answer = { body: object; status: Status };

const hex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`));
const ActionBody = z.strictObject({ actionId: z.string().regex(ACTION_ID) });
const GateActionSchema = z.strictObject({
  kind: z.literal("resolve-gate"),
  gateId: z.string().min(1).max(512),
  runId: z.string().min(1).max(256),
  stepId: z.string().min(1).max(256),
  repo: z.string().min(1).max(256),
  pr: z.number().int().positive(),
  headSha: hex(40),
  decision: z.literal("merge"),
});
/** No resolver field: the release is always the console's owner-remote, whatever else the record says. */
const ReleaseActionSchema = z.strictObject({
  kind: z.literal("owner-release"),
  repo: z.string().min(1).max(256),
  pr: z.number().int().positive(),
  headSha: hex(40),
});
/** The console writes the rest of the record (read-back, digest, session, peer class); the factory reads only the action. */
const ActionRecord = z.looseObject({ action: z.discriminatedUnion("kind", [GateActionSchema, ReleaseActionSchema]) });
type GateAction = z.infer<typeof GateActionSchema>;
type ReleaseAction = z.infer<typeof ReleaseActionSchema>;
type PrAt = Pick<GateAction, "repo" | "pr" | "headSha">;

type RefusalCode = "record" | "record-unreadable" | "class" | "mismatch" | "resolver" | "payload" | "github-unreadable";
type Outcome =
  | { outcome: "resolved"; gateId: string }
  | { outcome: "already"; gateId: string }
  | { outcome: "released"; runId: string; stillHeld: string | null }
  | { outcome: "already"; runId: string }
  | { outcome: "moved"; currentHead: string | undefined }
  | { outcome: "gone"; reason: string }
  | { outcome: "refused"; reason: RefusalCode; detail: string };

interface ConsoleActionDeps {
  host: FactoryHost;
  /** Fresh PR reads; absent without the shepherd routes, and then the route answers 503. */
  port: GitHubPort | undefined;
  /** Shepherd's registrations, for an owner-release; absent without the shepherd routes, as `port` is. */
  store: ShepherdStoreRef | undefined;
  /** The console's owner-written action records; each request reads its own record from here and nowhere else. */
  actionsDir: string;
  log: Logger;
}

/** One record as read: its exact bytes and the action they name. */
interface Read<A = GateAction | ReleaseAction> {
  action: A;
  confirmEvent: string;
}

/** The console's one identity in every resolve and release it asks for; the record never chooses it. */
const consoleResolver = (confirmEvent: string): GateResolver => ({ class: "owner-remote", id: "titan-console", channel: "console:inbox", confirmEvent });

/**
 * A console inbox tap as an owner-remote resolve of the approve-merge gate the owner confirmed, or as an owner-remote release
 * of the owner-asked hold on the PR the owner confirmed. Mounted on serve through the
 * daemon's `mountRoutes`, behind its Host, Origin, client-header and JSON guards, and kept out of the registry so it is never an
 * MCP tool or RPC command. No token: the trust boundary is the OS account, as for answer-ship. The body names only the action id;
 * what to do comes from the console's record file, and the gate, the allowlist and GitHub's live head must all agree with it.
 */
export function mountConsoleAction(app: App, deps: ConsoleActionDeps): void {
  app.post(CONSOLE_ACTION_PATH, async (c) => {
    const answer = await consoleAction(c.req.raw, deps);
    if (answer.status === 413) c.header("connection", "close");
    return c.json(answer.body, answer.status);
  });
}

async function consoleAction(raw: Request, deps: ConsoleActionDeps): Promise<Answer> {
  const text = await readCapped(raw, MAX_ACTION_BODY_BYTES);
  if (text === TOO_LARGE) return failure(413, `action body over ${MAX_ACTION_BODY_BYTES} bytes`);
  const actionId = parseBody(text);
  if (actionId === undefined) return failure(400, "body must be {actionId}");
  if (deps.port === undefined || deps.store === undefined) return failure(503, "shepherd routes not mounted");
  try {
    const outcome = await acted(actionId, deps.port, deps.store.get(), deps);
    deps.log.info({ actionId, ...outcome }, "answered a console action");
    return { body: outcome, status: statusOf(outcome) };
  } catch (error) {
    deps.log.error({ err: error instanceof Error ? error.message : String(error), actionId }, "answering a console action failed");
    return failure(500, "answering the console action failed");
  }
}

async function acted(actionId: string, port: GitHubPort, store: ShepherdStore, deps: ConsoleActionDeps): Promise<Outcome> {
  const read = await readRecord(deps.actionsDir, actionId);
  if ("outcome" in read) return read;
  const { action, confirmEvent } = read;
  return action.kind === "owner-release" ? releaseHold({ action, confirmEvent }, port, store) : resolveGate({ action, confirmEvent }, port, deps.host);
}

async function resolveGate(read: Read<GateAction>, port: GitHubPort, host: FactoryHost): Promise<Outcome> {
  const { action } = read;
  const gate = host.gates.get(action.gateId);
  if (gate === undefined) return { outcome: "gone", reason: `no gate ${action.gateId}` };
  const land = gateRefusal(gate, action);
  if ("outcome" in land) return land;
  if (gate.status !== "pending") return settled(gate, read.confirmEvent, `the gate is ${gate.status}`);
  const stale = storeMoved(host, gate, land, action) ?? (await githubOutcome(port, action));
  return stale ?? resolveOnce(read, host);
}

/** The record's gate must be one the console may answer, and ask about the record's PR. */
function gateRefusal(gate: GateRecord, action: GateAction): LandGate | Outcome {
  if (!stepIdMatches(`${action.runId}/${action.stepId}`, gate.id)) return refused("record", `gate ${gate.id} is not step ${action.stepId} of run ${action.runId}`);
  const land = CONSOLE_STEPS.has(stepOf(gate.id)) ? landGate(gate) : undefined;
  if (land === undefined) return refused("class", `${gate.id} is ${batchRefusal(gate) ?? "not on the console's approve-merge allowlist"}`);
  const samePr = land.repo.toLowerCase() === action.repo.toLowerCase() && land.pr === action.pr;
  return samePr ? land : refused("mismatch", `${gate.id} asks about ${land.repo}#${land.pr}, the record names ${action.repo}#${action.pr}`);
}

/** The run waits on a newer gate for the step, or the gate itself pins a head other than the one the owner confirmed. */
function storeMoved(host: FactoryHost, gate: GateRecord, land: LandGate, action: GateAction): Outcome | undefined {
  const waiting = pendingGateId(host, action.runId, stepOf(gate.id));
  if (waiting !== undefined && waiting !== gate.id) return { outcome: "moved", currentHead: headOf(host, waiting) };
  return land.head === action.headSha ? undefined : { outcome: "moved", currentHead: land.head };
}

function headOf(host: FactoryHost, gateId: string): string | undefined {
  const gate = host.gates.get(gateId);
  return gate ? landGate(gate)?.head : undefined;
}

/** GitHub's own head, read fresh: the gate prompt is Shepherd's earlier read and may be behind the PR. */
async function githubOutcome(port: GitHubPort, { repo, pr, headSha }: PrAt): Promise<Outcome | undefined> {
  try {
    const pull = await port.getPr(repo, pr);
    if (pull.state !== "open") return { outcome: "gone", reason: `${repo}#${pr} is ${pull.merged ? "merged" : "closed"} on GitHub` };
    return pull.headSha === headSha ? undefined : { outcome: "moved", currentHead: pull.headSha };
  } catch (error) {
    return refused("github-unreadable", `${repo}#${pr} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The store settles a gate once, so of two concurrent posts of one record only one resolves; the other reads back `already`. */
function resolveOnce({ action, confirmEvent }: Read<GateAction>, host: FactoryHost): Outcome {
  try {
    host.gates.resolve(action.gateId, { decision: action.decision, headSha: action.headSha }, consoleResolver(confirmEvent));
  } catch (error) {
    if (error instanceof GateResolverRefused) return refused("resolver", error.message);
    if (error instanceof GatePayloadInvalid) return refused("payload", error.message);
    if (error instanceof GateAlreadySettled || error instanceof GateExpired || error instanceof GateNotFound) return settledNow(host, action.gateId, confirmEvent, error.message);
    throw error;
  }
  return { outcome: "resolved", gateId: action.gateId };
}

function settledNow(host: FactoryHost, gateId: string, confirmEvent: string, reason: string): Outcome {
  const gate = host.gates.get(gateId);
  return gate ? settled(gate, confirmEvent, reason) : { outcome: "gone", reason };
}

/** `already` only when this very record resolved the gate: the confirm event is the record's own sha256. */
function settled(gate: GateRecord, confirmEvent: string, reason: string): Outcome {
  const mine = gate.status === "resolved" && gate.resolvedBy?.confirmEvent === confirmEvent;
  return mine ? { outcome: "already", gateId: gate.id } : { outcome: "gone", reason };
}

/**
 * Lifts the owner-asked hold on the record's PR, and only that hold, at the head the owner confirmed. Shepherd's own
 * checks run again inside `ownerRelease`; reading them first here is what lets the console tell moved from gone.
 */
async function releaseHold({ action, confirmEvent }: Read<ReleaseAction>, port: GitHubPort, store: ShepherdStore): Promise<Outcome> {
  const registration = store.byPr(action.repo, action.pr);
  if (registration === undefined) return { outcome: "gone", reason: `${action.repo}#${action.pr} is not registered with shepherd` };
  const { runId } = registration;
  const before = releasedBefore(store, runId, confirmEvent);
  if (before !== undefined) return before;
  if (registration.ownerHold === null) return { outcome: "gone", reason: `${action.repo}#${action.pr} holds no owner-asked hold` };
  const stale = await githubOutcome(port, action);
  return stale ?? releaseOnce(store, port, { ...action, runId }, confirmEvent);
}

/**
 * `already` only when this very record lifted a hold: `ownerRelease` writes the resolver's proof into the event's actor. Read
 * before the hold state, so one confirmation never lifts a newer owner-asked hold placed after it.
 */
function releasedBefore(store: ShepherdStore, runId: string, confirmEvent: string): Outcome | undefined {
  const actor = `owner-remote:titan-console proof ${confirmEvent}`;
  return store.eventsOf(runId).some((event) => event.kind === "release" && event.actor === actor) ? { outcome: "already", runId } : undefined;
}

/** Of two concurrent posts of one record only one lifts the hold; the other loses inside `ownerRelease` and reads back `already`. */
async function releaseOnce(store: ShepherdStore, port: GitHubPort, { repo, pr, headSha, runId }: ReleaseAction & { runId: string }, confirmEvent: string): Promise<Outcome> {
  try {
    const after = await ownerRelease(store, port, { repo, pr, head: headSha }, consoleResolver(confirmEvent));
    return { outcome: "released", runId, stillHeld: after.held ? after.holdReason : null };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    if (code === EXIT.NOPERM) return refused("resolver", message);
    if (code === EXIT.UNAVAILABLE) return refused("github-unreadable", message);
    if (error instanceof Error && "currentHead" in error && typeof error.currentHead === "string") return { outcome: "moved", currentHead: error.currentHead };
    if (code === EXIT.DATAERR || code === EXIT.NOINPUT) return releasedBefore(store, runId, confirmEvent) ?? { outcome: "gone", reason: message };
    throw error;
  }
}

/** A missing record is `gone`: the console never wrote it, or it was cleaned up. Anything else unreadable is refused. */
async function readRecord(actionsDir: string, actionId: string): Promise<Read | Outcome> {
  const name = `${actionId}.json`;
  const handle = await open(join(actionsDir, name), OPEN_FLAGS).catch((error: unknown) => codeOf(error));
  if (typeof handle === "string") return handle === "ENOENT" ? { outcome: "gone", reason: `no action record ${actionId}` } : refused("record-unreadable", `${name} could not be opened (${handle})`);
  try {
    if (!(await handle.stat()).isFile()) return refused("record-unreadable", `${name} is not a regular file`);
    const buffer = Buffer.alloc(MAX_ACTION_RECORD_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_ACTION_RECORD_BYTES) return refused("record-unreadable", `${name} is over ${MAX_ACTION_RECORD_BYTES} bytes`);
    return parseRecord(buffer.subarray(0, bytesRead), name);
  } finally {
    await handle.close();
  }
}

function parseRecord(bytes: Uint8Array, name: string): Read | Outcome {
  try {
    const parsed = ActionRecord.safeParse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    if (parsed.success) return { action: parsed.data.action, confirmEvent: `action:${createHash("sha256").update(bytes).digest("hex")}` };
  } catch {
    // An unparseable record is refused below, the same as a misshapen one.
  }
  return refused("record", `${name} does not read as a resolve-gate or owner-release action record`);
}

const refused = (reason: RefusalCode, detail: string): Outcome => ({ outcome: "refused", reason, detail });

const codeOf = (error: unknown): string => (error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "EIO");

function statusOf(outcome: Outcome): Status {
  switch (outcome.outcome) {
    case "resolved":
    case "released":
    case "already":
      return 200;
    case "moved":
      return 409;
    case "gone":
      return 410;
    case "refused":
      return outcome.reason === "github-unreadable" ? 503 : outcome.reason === "class" || outcome.reason === "resolver" ? 403 : 422;
  }
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
