/**
 * The client of titan-factory's `POST /owner/console-action`: the body names an action id, and the factory reads what to do from
 * the console's own record file `<actionsDir>/<id>.json`. The console depends on the factory only across this HTTP call, so the
 * response shapes are pinned here, not imported: `resolved` and `already` for a gate, `released` and `already` for an owner-asked
 * hold, `moved`, `gone` and `refused` for either.
 */
import { z } from "zod";

const ACTION_PATH = "/owner/console-action";
const POST_TIMEOUT_MS = 10_000;

export type ActionOutcome =
  | { status: "resolved"; gateId: string }
  | { status: "released"; runId: string; stillHeld: string | null }
  | { status: "already"; gateId?: string; runId?: string }
  | { status: "moved"; currentHead: string | null }
  | { status: "gone"; reason: string }
  | { status: "refused"; reason: string; detail?: string }
  | { status: "off" };
export type Unreachable = { status: "unreachable"; detail: string };

export interface OwnerActionClient {
  /** Never rejects: a factory that cannot be reached, or answers badly, comes back as `unreachable`. */
  post(actionId: string): Promise<ActionOutcome | Unreachable>;
}

const routeBody = z.looseObject({
  outcome: z.string().optional(),
  gateId: z.string().optional(),
  runId: z.string().optional(),
  stillHeld: z.string().nullable().optional(),
  currentHead: z.string().nullable().optional(),
  reason: z.string().optional(),
  detail: z.string().optional(),
  error: z.string().optional(),
});

type RouteBody = z.infer<typeof routeBody>;

const unreachable = (detail: string): Unreachable => ({ status: "unreachable", detail });

function settledOutcome({ outcome, gateId, runId, stillHeld }: RouteBody): ActionOutcome | undefined {
  if (outcome === "resolved" && gateId) return { status: "resolved", gateId };
  if (outcome === "released" && runId && stillHeld !== undefined) return { status: "released", runId, stillHeld };
  if (outcome === "already" && (gateId || runId)) return { status: "already", ...(gateId && { gateId }), ...(runId && { runId }) };
  return undefined;
}

/**
 * 503 is the factory unable to read GitHub or its shepherd store, and 500 its own failure: neither is a verdict on the action,
 * so both are unreachable and a retry may succeed. 404 is the route not mounted, which is the factory's `actionsDir` unset.
 */
function outcomeOf(status: number, body: RouteBody): ActionOutcome | Unreachable {
  if (status === 404) return { status: "off" };
  if (status >= 500) return unreachable(`factory answered ${status}: ${body.detail ?? body.error ?? "unavailable"}`);
  const settled = status === 200 ? settledOutcome(body) : undefined;
  if (settled !== undefined) return settled;
  if (status === 409 && body.outcome === "moved") return { status: "moved", currentHead: body.currentHead ?? null };
  if (status === 410 && body.outcome === "gone") return { status: "gone", reason: body.reason ?? "gone" };
  if (body.outcome === "refused") return { status: "refused", reason: body.reason ?? "refused", ...(body.detail !== undefined && { detail: body.detail }) };
  if (status === 400 || status === 413) return { status: "refused", reason: status === 413 ? "too-large" : "bad-request", ...(body.error !== undefined && { detail: body.error }) };
  return unreachable(`factory answered ${status} with an unexpected body`);
}

export function factoryOwnerAction(port: number, timeoutMs: number = POST_TIMEOUT_MS): OwnerActionClient {
  return {
    async post(actionId) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${ACTION_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-titan-client": "rpc-client" },
          body: JSON.stringify({ actionId }),
          redirect: "manual",
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
