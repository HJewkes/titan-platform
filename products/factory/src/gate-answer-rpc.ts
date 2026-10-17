import { appendFileSync, constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Logger, StartDaemonOptions } from "@titan-design/daemon";
import type { GitHubPort } from "@titan-design/github";
import { GateAlreadySettled, GateExpired, GateNotFound, GatePayloadInvalid, GateResolverRefused, type GateResolver } from "@titan-design/hitl";
import { EXIT, errorEnvelope } from "@titan-design/registry";
import { z } from "zod";
import { MAX_SET_FILES, afterDigest, keptImages, setPacketOf, type AfterDigest } from "./approved-set.js";
import { configPath, loadConfig } from "./config.js";
import { stepOf } from "./coordinator-evidence.js";
import { stepIdMatches } from "./definition.js";
import { checkAnswer, type AcceptFiles, type AnswerPayload, type AnswerRequest } from "./gate-answer-check.js";
import { repeatedResolution } from "./gate-resolve.js";
import type { FactoryHost } from "./host.js";
import { readCapped, TOO_LARGE } from "./resolve-proof.js";
import type { VisualSetCarry } from "./shepherd/phases.js";
import { VISUAL_ACCEPT_GATE, configuredVisualSetCarry } from "./shepherd/visual-accept.js";
import { deliveryFileFor } from "./shepherd/visual-delivery.js";
import { packetDirFor } from "./shepherd/visual-packet-trigger.js";

export const ANSWER_SHIP_PATH = "/gates/answer-ship";
export const MAX_ANSWER_BODY_BYTES = 64 * 1024;
const MAX_ROUND_FILE_BYTES = 1024 * 1024;
const MAX_AFTER_IMAGE_BYTES = 16 * 1024 * 1024;
/** The console's own round id rule, so the id can never name a path outside the rounds dir. */
const ROUND_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** O_NONBLOCK so a planted FIFO cannot hang the open; O_NOFOLLOW so a symlinked file is refused, not followed. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const FOLLOW_UPS_FILE = "follow-ups.jsonl";

type App = Parameters<NonNullable<StartDaemonOptions["mountRoutes"]>>[0];
type Status = 200 | 400 | 403 | 409 | 410 | 413 | 422 | 500 | 503;
type Answer = { body: object; status: Status };
type RoundFiles = { round: Uint8Array; packet: Uint8Array; feedback: Uint8Array };

const hex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`), `must be ${length} lowercase hex digits`);
const AnswerBody = z.strictObject({
  runId: z.string().min(1).max(256),
  gateId: z.string().min(1).max(512),
  headSha: hex(40),
  tree: hex(40),
  packetSha: hex(64),
  roundId: z.string().regex(ROUND_ID),
  choice: z.enum(["merge", "send-back", "merge-pick-later", "accept-set"]),
});

type Outcome =
  | { outcome: "resolved"; gateId: string; choice: AnswerRequest["choice"] }
  | { outcome: "already"; gateId: string }
  | { outcome: "moved"; currentHead: string | undefined; waitsOn?: string }
  | { outcome: "gone"; reason: string }
  | { outcome: "refused"; reason: string; detail: string };

interface GateAnswerDeps {
  host: FactoryHost;
  /** Fresh PR and commit reads; absent without the shepherd routes, and then the route answers 503. */
  port: Pick<GitHubPort, "getPr" | "getCommit"> | undefined;
  /** The console's rounds dir; each answer reads its own round's files from here and nowhere else. */
  roundsDir: string;
  /** Where `follow-ups.jsonl` is appended for a merge-pick-later answer. */
  stateDir: string;
  now: () => number;
  log: Logger;
  /** `shepherd.visualSetCarry`, read per answer; absent reads the config file. */
  visualSetCarry?: () => VisualSetCarry;
}

export interface ConsoleAnswersOptions {
  roundsDir: string;
}

/** `shepherd.consoleAnswers` from the factory config; absent means the route is not mounted. */
export function configuredConsoleAnswers(env: NodeJS.ProcessEnv): ConsoleAnswersOptions | undefined {
  return loadConfig(configPath(env)).shepherd?.consoleAnswers;
}

/**
 * The console's Ship answer as an owner-remote resolve of the approve-merge gate it was shown. Mounted on serve through the
 * daemon's `mountRoutes`, behind its Host, Origin, client-header and JSON guards, and kept out of the registry so it is never an
 * MCP tool or RPC command. No token: the trust boundary is the OS account, as for gateNotify. The request only names the round;
 * the choice comes from the owner's feedback.json there, and the gate, GitHub, the packet and the feedback must all agree.
 */
export function mountGateAnswer(app: App, deps: GateAnswerDeps): void {
  app.post(ANSWER_SHIP_PATH, async (c) => {
    const answer = await answerShip(c.req.raw, deps);
    if (answer.status === 413) c.header("connection", "close");
    return c.json(answer.body, answer.status);
  });
}

async function answerShip(raw: Request, deps: GateAnswerDeps): Promise<Answer> {
  const text = await readCapped(raw, MAX_ANSWER_BODY_BYTES);
  if (text === TOO_LARGE) return failure(413, `answer body over ${MAX_ANSWER_BODY_BYTES} bytes`);
  const request = parseRequest(text);
  if (request === undefined) return failure(400, "body must be {runId, gateId, headSha, tree, packetSha, roundId, choice}");
  if (deps.port === undefined) return failure(503, "shepherd routes not mounted");
  try {
    const outcome = await answered(request, deps.port, deps);
    deps.log.info({ runId: request.runId, gateId: request.gateId, roundId: request.roundId, ...outcome }, "answered a console Ship");
    return { body: outcome, status: statusOf(outcome) };
  } catch (error) {
    deps.log.error({ err: error instanceof Error ? error.message : String(error), gateId: request.gateId }, "answering a console Ship failed");
    return failure(500, "answering the Ship failed");
  }
}

async function answered(request: AnswerRequest, port: NonNullable<GateAnswerDeps["port"]>, deps: GateAnswerDeps): Promise<Outcome> {
  if (request.choice === "accept-set" && (deps.visualSetCarry ?? configuredVisualSetCarry)() === "off") return { outcome: "refused", reason: "off", detail: "shepherd.visualSetCarry is off" };
  const files = await readRound(deps.roundsDir, request.roundId);
  if (typeof files === "string") return { outcome: "refused", reason: "round-unreadable", detail: files };
  const accept = isAcceptGate(deps.host, request) ? await readAccept(deps.stateDir, request) : undefined;
  const check = await checkAnswer({ host: deps.host, port, request, files, ...(accept !== undefined && { accept }), now: new Date(deps.now()) });
  switch (check.kind) {
    case "resolve":
      return resolveOnce(request, check.payload, deps);
    case "already":
      return { outcome: "already", gateId: check.gateId };
    case "moved":
      return { outcome: "moved", currentHead: check.currentHead, ...(check.waitsOn !== undefined && { waitsOn: check.waitsOn }) };
    case "gone":
      return { outcome: "gone", reason: check.reason };
    case "refused":
      return { outcome: "refused", reason: check.reason, detail: check.detail };
  }
}

/** The store settles a gate once, so of two concurrent answers only one resolves; the other reads back what happened. */
function resolveOnce(request: AnswerRequest, payload: AnswerPayload, deps: GateAnswerDeps): Outcome {
  const resolver: GateResolver = { class: "owner-remote", id: "titan-console", channel: "console:ship", confirmEvent: `packet:${request.packetSha}` };
  try {
    deps.host.gates.resolve(request.gateId, payload, resolver);
  } catch (error) {
    if (error instanceof GateResolverRefused) return { outcome: "refused", reason: "resolver", detail: error.message };
    if (error instanceof GatePayloadInvalid) return { outcome: "refused", reason: "payload", detail: error.message };
    if (error instanceof GateAlreadySettled || error instanceof GateExpired || error instanceof GateNotFound) return settled(request, payload, deps.host, error.message);
    throw error;
  }
  if (request.choice === "merge-pick-later") appendFollowUp(request, payload.headSha, deps);
  return { outcome: "resolved", gateId: request.gateId, choice: request.choice };
}

function settled(request: AnswerRequest, payload: Record<string, unknown>, host: FactoryHost, reason: string): Outcome {
  if (repeatedResolution(host, request.runId, stepOf(request.gateId), payload) === request.gateId) return { outcome: "already", gateId: request.gateId };
  return { outcome: "gone", reason };
}

/** Written only after this call resolved the gate, so a replay or a lost race never adds a second line. */
function appendFollowUp(request: AnswerRequest, headSha: string, deps: GateAnswerDeps): void {
  const { runId, gateId, packetSha, roundId } = request;
  const line = { at: new Date(deps.now()).toISOString(), runId, gateId, headSha, packetSha, roundId, kind: "pick-later" };
  try {
    appendFileSync(join(deps.stateDir, FOLLOW_UPS_FILE), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (error) {
    deps.log.error({ err: error instanceof Error ? error.message : String(error), ...line }, "could not record a pick-later follow-up");
  }
}

/** Why a round's files cannot be read; carried as an error so the three reads stay one `Promise.all`. */
class RoundUnreadable extends Error {}

/** The round dir must be a real directory and each file a regular file, none of them a symlink. */
async function readRound(roundsDir: string, roundId: string): Promise<RoundFiles | string> {
  const dir = join(roundsDir, roundId);
  const stats = await lstat(dir).catch(() => null);
  if (!stats?.isDirectory()) return `round ${roundId} is not a directory in the rounds dir`;
  try {
    const [round, packet, feedback] = await Promise.all([readNoFollow(dir, "round.json"), readNoFollow(dir, "packet.json"), readNoFollow(dir, "feedback.json")]);
    return { round, packet, feedback };
  } catch (error) {
    if (error instanceof RoundUnreadable) return error.message;
    throw error;
  }
}

/** Only a gate the store holds names the run, so the run id that builds the packet path was never the request's own text. */
const isAcceptGate = (host: FactoryHost, request: AnswerRequest): boolean =>
  host.gates.get(request.gateId) !== undefined && stepIdMatches(`${request.runId}/${VISUAL_ACCEPT_GATE}`, request.gateId);

/** The factory's own packet for the head, its kept after images as digests, and the delivery record; never the console's copies. */
async function readAccept(stateDir: string, { runId, headSha }: AnswerRequest): Promise<AcceptFiles | string> {
  const dir = packetDirFor(stateDir, runId, headSha);
  const record = deliveryFileFor(stateDir, runId, headSha);
  try {
    const packet = await readNoFollow(dir, "packet.json");
    const kept = keptImages(setPacketOf(packet) ?? { images: [] });
    const after = new Map<string, AfterDigest>();
    for (const { key } of kept.length > MAX_SET_FILES ? [] : kept) after.set(key, afterDigest(await readNoFollow(join(dir, "after"), `${key}.png`, MAX_AFTER_IMAGE_BYTES)));
    const delivery = await readNoFollow(dirname(record), basename(record)).catch(() => undefined);
    return { packet, after, delivery };
  } catch (error) {
    if (error instanceof RoundUnreadable) return `the factory's packet for ${headSha}: ${error.message}`;
    throw error;
  }
}

async function readNoFollow(dir: string, name: string, maxBytes = MAX_ROUND_FILE_BYTES): Promise<Uint8Array> {
  const handle = await open(join(dir, name), OPEN_FLAGS).catch((error: unknown) => {
    throw new RoundUnreadable(`${name} could not be opened (${codeOf(error)})`);
  });
  try {
    if (!(await handle.stat()).isFile()) throw new RoundUnreadable(`${name} is not a regular file`);
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new RoundUnreadable(`${name} is over ${maxBytes} bytes`);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const codeOf = (error: unknown): string => (error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "EIO");

function statusOf(outcome: Outcome): Status {
  switch (outcome.outcome) {
    case "resolved":
    case "already":
      return 200;
    case "moved":
      return 409;
    case "gone":
      return 410;
    case "refused":
      return outcome.reason === "github-unreadable" ? 503 : outcome.reason === "resolver" ? 403 : 422;
  }
}

function failure(status: Status, message: string): Answer {
  const code = status === 503 ? EXIT.UNAVAILABLE : status === 500 ? EXIT.SOFTWARE : EXIT.DATAERR;
  return { body: errorEnvelope(message, code), status };
}

function parseRequest(raw: string): AnswerRequest | undefined {
  try {
    const parsed = AnswerBody.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
