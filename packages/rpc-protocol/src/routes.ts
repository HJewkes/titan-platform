import { EXIT } from "./envelope.js";

/** `POST ${RPC_PREFIX}<command>` runs one command; the body is its JSON args. */
export const RPC_PREFIX = "/rpc/";
/** Server-sent events: the reserved frames in `sse.ts` plus whatever the product broadcasts. */
export const EVENTS_PATH = "/events";
/** 503 until the daemon is ready, then the health payload. */
export const HEALTH_PATH = "/health";
export const VERSION_PATH = "/version";

/**
 * A state-changing request with no `Origin` must carry this header, any non-empty value
 * (conventionally the client's name). A browser page cannot add it without a preflight.
 */
export const CLIENT_HEADER = "x-titan-client";

/** The statuses `POST /rpc/:name` answers with besides 200. */
export const RPC_STATUS = {
  /** Invalid JSON body, or a command failing with `EXIT.DATAERR`. */
  BAD_REQUEST: 400,
  /** No command by that name. */
  NOT_FOUND: 404,
  /** The command failed with any other code. */
  FAILED: 500,
} as const;

/** DATAERR is the caller's fault whether it came from schema validation or the command. */
export function rpcFailureStatus(code: number): typeof RPC_STATUS.BAD_REQUEST | typeof RPC_STATUS.FAILED {
  return code === EXIT.DATAERR ? RPC_STATUS.BAD_REQUEST : RPC_STATUS.FAILED;
}
