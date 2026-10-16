/**
 * The client of titan-factory's `POST /gates/answer-ship`: the owner's Ship or Send back, relayed
 * as an owner-remote resolve of the approve-merge gate the round showed. The console depends on
 * the factory only across this HTTP call, so the response shapes are pinned here, not imported.
 */
import { z } from "zod";

const ANSWER_PATH = "/gates/answer-ship";
const READ_TIMEOUT_MS = 10_000;

export const ANSWER_CHOICES = ["merge", "send-back"] as const;
export type AnswerChoice = (typeof ANSWER_CHOICES)[number];

/** What the route takes; every field is read from the round's files, none from the browser. */
export interface GateAnswerRequest {
  runId: string;
  gateId: string;
  headSha: string;
  tree: string;
  packetSha: string;
  roundId: string;
  choice: AnswerChoice;
}

/** What `answer.json` records: the route's result, normalised. A factory that is down is not an outcome. */
export const answerOutcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("resolved"), gateId: z.string(), choice: z.enum(ANSWER_CHOICES) }),
  z.object({ status: z.literal("already"), gateId: z.string() }),
  z.object({ status: z.literal("moved"), currentHead: z.string().nullable(), waitsOn: z.string().optional() }),
  z.object({ status: z.literal("gone"), reason: z.string() }),
  z.object({ status: z.literal("refused"), reason: z.string(), detail: z.string().optional() }),
  z.object({ status: z.literal("off") }),
]);

export type AnswerOutcome = z.infer<typeof answerOutcome>;
export type Unreachable = { status: "unreachable"; detail: string };

export interface GateAnswerClient {
  /** Never rejects: a factory that cannot be reached or answers badly comes back as `unreachable`. */
  post(request: GateAnswerRequest): Promise<AnswerOutcome | Unreachable>;
}

const routeBody = z.looseObject({
  outcome: z.string().optional(),
  gateId: z.string().optional(),
  choice: z.string().optional(),
  currentHead: z.string().nullable().optional(),
  waitsOn: z.string().optional(),
  reason: z.string().optional(),
  detail: z.string().optional(),
  error: z.string().optional(),
});

type RouteBody = z.infer<typeof routeBody>;

const unreachable = (detail: string): Unreachable => ({ status: "unreachable", detail });

/**
 * 503 and 500 are the factory failing to read GitHub or the gate, not a verdict on the answer, so
 * they are unreachable and a retry may succeed; everything else is a settled answer.
 */
function outcomeOf(status: number, body: RouteBody): AnswerOutcome | Unreachable {
  if (status === 404) return { status: "off" };
  if (status >= 500) return unreachable(`factory answered ${status}: ${body.reason ?? body.error ?? "unavailable"}`);
  const outcome = body.outcome;
  if (status === 200 && outcome === "resolved" && body.gateId && (body.choice === "merge" || body.choice === "send-back")) {
    return { status: "resolved", gateId: body.gateId, choice: body.choice };
  }
  if (status === 200 && outcome === "already" && body.gateId) return { status: "already", gateId: body.gateId };
  if (status === 409 && outcome === "moved") return { status: "moved", currentHead: body.currentHead ?? null, ...(body.waitsOn !== undefined && { waitsOn: body.waitsOn }) };
  if (status === 410 && outcome === "gone") return { status: "gone", reason: body.reason ?? "gate closed" };
  if (outcome === "refused") return { status: "refused", reason: body.reason ?? "refused", ...(body.detail !== undefined && { detail: body.detail }) };
  if (status === 400 || status === 413) return { status: "refused", reason: status === 413 ? "too-large" : "bad-request", ...(body.error !== undefined && { detail: body.error }) };
  return unreachable(`factory answered ${status} with an unexpected body`);
}

export function factoryGateAnswer(port: number, timeoutMs: number = READ_TIMEOUT_MS): GateAnswerClient {
  return {
    async post(request) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${ANSWER_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-titan-client": "rpc-client" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const parsed = routeBody.safeParse(await response.json().catch(() => ({})));
        return outcomeOf(response.status, parsed.success ? parsed.data : {});
      } catch (error) {
        return unreachable(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
