/** What every surface returns for a command: data on success, a message and code on failure. */
type JsonEnvelope<T> = {
    ok: true;
    data: T;
    warnings?: string[];
} | {
    ok: false;
    error: string;
    code: number;
};
declare function successEnvelope<T>(data: T, warnings?: string[]): JsonEnvelope<T>;
declare function errorEnvelope(error: string, code: number): JsonEnvelope<never>;
/** BSD sysexits codes, the shared vocabulary for envelope `code` and CLI exit status. */
declare const EXIT: {
    readonly OK: 0;
    readonly GENERIC: 1;
    readonly USAGE: 64;
    readonly DATAERR: 65;
    readonly NOINPUT: 66;
    readonly UNAVAILABLE: 69;
    readonly SOFTWARE: 70;
    /** The caller is over a limit and may retry later; `POST /rpc/:name` answers 429. */
    readonly TEMPFAIL: 75;
    /** The caller may not run this command; `POST /rpc/:name` answers 403. */
    readonly NOPERM: 77;
    readonly CONFIG: 78;
};

/** `POST ${RPC_PREFIX}<command>` runs one command; the body is its JSON args. */
declare const RPC_PREFIX = "/rpc/";
/** Server-sent events: the reserved frames in `sse.ts` plus whatever the product broadcasts. */
declare const EVENTS_PATH = "/events";
/** 503 until the daemon is ready, then the health payload. */
declare const HEALTH_PATH = "/health";
declare const VERSION_PATH = "/version";
/**
 * A state-changing request with no `Origin` must carry this header, any non-empty value
 * (conventionally the client's name). A browser page cannot add it without a preflight.
 */
declare const CLIENT_HEADER = "x-titan-client";
/** The statuses `POST /rpc/:name` answers with besides 200. */
declare const RPC_STATUS: {
    /** Invalid JSON body, or a command failing with `EXIT.DATAERR`. */
    readonly BAD_REQUEST: 400;
    /** A command refusing this caller with `EXIT.NOPERM`. */
    readonly FORBIDDEN: 403;
    /** No command by that name. */
    readonly NOT_FOUND: 404;
    /** A command refusing a caller over its limit with `EXIT.TEMPFAIL`. */
    readonly TOO_MANY_REQUESTS: 429;
    /** The command failed with any other code. */
    readonly FAILED: 500;
};
type RpcFailureStatus = (typeof RPC_STATUS)[Exclude<keyof typeof RPC_STATUS, "NOT_FOUND">];
/** DATAERR is the caller's fault whether it came from schema validation or the command. */
declare function rpcFailureStatus(code: number): RpcFailureStatus;

/** One server-sent event frame: `event: <event>\ndata: <data>\n\n`. */
interface SseMessage {
    event: string;
    data: string;
}
/** Event names the daemon emits on its own; products broadcast any other name. */
declare const SSE_EVENTS: {
    /** Sent once on connect, with `SSE_READY_DATA` as its data. */
    readonly READY: "ready";
    /** Keep-alive every `SSE_HEARTBEAT_MS`; its data is the server's `Date.now()`. */
    readonly PING: "ping";
};
declare const SSE_READY_DATA = "connected";
/** Interval between SSE keep-alive frames (ms). */
declare const SSE_HEARTBEAT_MS = 25000;

/** Command name to its args and result: the only type a client needs to be fully typed. */
type CommandMap = Record<string, {
    args: unknown;
    result: unknown;
}>;

export { CLIENT_HEADER, type CommandMap, EVENTS_PATH, EXIT, HEALTH_PATH, type JsonEnvelope, RPC_PREFIX, RPC_STATUS, SSE_EVENTS, SSE_HEARTBEAT_MS, SSE_READY_DATA, type SseMessage, VERSION_PATH, errorEnvelope, rpcFailureStatus, successEnvelope };
