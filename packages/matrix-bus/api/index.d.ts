type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
declare class MatrixError extends Error {
    readonly status: number;
    readonly errcode: string | undefined;
    readonly body: unknown;
    constructor(status: number, errcode: string | undefined, body: unknown, message: string);
}
interface RequestOptions {
    token?: string;
    body?: unknown;
    query?: Record<string, string | undefined>;
    signal?: AbortSignal;
}

interface MatrixEvent {
    type: string;
    event_id: string;
    sender: string;
    content: Record<string, unknown>;
    origin_server_ts?: number;
    state_key?: string;
    room_id?: string;
    unsigned?: Record<string, unknown>;
}
interface MessagesPage {
    chunk: MatrixEvent[];
    start: string;
    end?: string;
    state?: MatrixEvent[];
}
/**
 * One /sync response. The bus is used for a single room (`#queue`), so `limited` and
 * `prev_batch` come from that room's timeline: `limited` true means the server omitted
 * older events in the gap, and `prev_batch` is the token to page backward from to
 * backfill it (e.g. after the client was offline, such as a laptop sleep).
 */
interface SyncBatch {
    since: string;
    events: MatrixEvent[];
    limited: boolean;
    prev_batch?: string;
}
interface Session {
    userId: string;
    accessToken: string;
    deviceId?: string;
}

interface SyncOptions {
    since?: string;
    filter?: string | Record<string, unknown>;
    timeoutMs?: number;
    signal?: AbortSignal;
}

interface AppserviceClientOptions {
    baseUrl: string;
    asToken: string;
    /** The user to act as; masquerades with ?user_id= unless it equals `sender`. */
    userId?: string;
    /** The user the token itself belongs to, when known (the appservice sender or a password session). */
    sender?: string;
    fetch?: FetchLike;
}
interface MessagesOptions {
    from?: string;
    dir?: "b" | "f";
    limit?: number;
}
declare class AppserviceClient {
    private readonly options;
    readonly userId: string | undefined;
    private readonly txnPrefix;
    private txnCounter;
    constructor(options: AppserviceClientOptions);
    private get masqueradeAs();
    request<T>(method: string, path: string, options?: RequestOptions): Promise<T>;
    private nextTxnId;
    send(roomId: string, type: string, content: Record<string, unknown>, txnId?: string): Promise<{
        event_id: string;
    }>;
    sendState(roomId: string, type: string, stateKey: string, content: Record<string, unknown>): Promise<{
        event_id: string;
    }>;
    state(roomId: string): Promise<MatrixEvent[]>;
    messages(roomId: string, { from, dir, limit }?: MessagesOptions): Promise<MessagesPage>;
    whoami(): Promise<{
        user_id: string;
        device_id?: string;
    }>;
    joinRoom(roomIdOrAlias: string): Promise<{
        room_id: string;
    }>;
    /** Registers a namespace user; an existing user is not an error. */
    register(localpart: string): Promise<void>;
    loginAs(localpart: string): Promise<Session>;
    /** Yields one batch per /sync response; the caller handles every event before persisting `since`, and dedupes by applied event id on replay. */
    syncLoop(options?: SyncOptions): AsyncGenerator<SyncBatch>;
}
/** Logs in an ordinary account; the password is used once and not kept. */
declare function loginPassword(baseUrl: string, user: string, password: string, fetch?: FetchLike): Promise<AppserviceClient>;

declare const ITEM_KEY = "io.titan.item";
declare const ITEM_VERSION = 1;
declare const ITEM_KINDS: readonly ["approval_request", "endorse_request", "question", "notice", "message"];
type ItemKind = (typeof ITEM_KINDS)[number];
/** The structured record carried inside an item's m.room.message content. */
interface TitanItem {
    v: 1;
    kind: ItemKind;
    machine: string;
    session: string;
    agent_id?: string;
    msg_id: string;
    at: number;
    tool_name?: string;
    input_preview?: string;
    recipient?: string;
    truncated: boolean;
    redacted: boolean;
}
/** An item plus the free text it shows; the text travels in `body` only. */
interface ItemInput extends Omit<TitanItem, "v"> {
    text?: string;
}
type ItemContent = {
    msgtype: "m.text";
    body: string;
    format?: "org.matrix.custom.html";
    formatted_body?: string;
    [ITEM_KEY]: TitanItem;
};
declare const TRUNCATED_LINE = "too large to approve from the phone; answer at the terminal";
declare const REDACTED_LINE = "secrets redacted; answer at the terminal";
declare function renderItemBody(item: ItemInput): string;
declare function encodeItem(item: ItemInput, formattedBody?: string): ItemContent;
/** Returns null for content without the key, an unknown version, or a malformed record. */
declare function decodeItem(content: Record<string, unknown>): TitanItem | null;

declare const RESOLUTION_EVENT = "io.titan.resolution";
type Verdict = "allow" | "deny" | "approve" | "dismiss" | "answer";
interface Resolution {
    itemEventId: string;
    verdict: Verdict;
    text?: string;
}
interface FoldContext {
    ownerUserId: string;
    /** Open items the caller posted, keyed by event id; the kind picks the verdict vocabulary. */
    itemEventIds: ReadonlyMap<string, ItemKind>;
}
declare function stripReplyFallback(body: string): string;
/** Folds an owner's reaction, reply or io.titan.resolution into a verdict on an open item; anything else is null. */
declare function foldResolution(event: MatrixEvent, { ownerUserId, itemEventIds }: FoldContext): Resolution | null;

declare const MAX_CONTENT_BYTES = 60000;
declare class ContentTooLargeError extends Error {
    readonly bytes: number;
    constructor(bytes: number);
}
declare function contentBytes(content: unknown): number;
declare function assertSendable(content: unknown): void;

interface PowerLevels {
    users: Record<string, number>;
    users_default: number;
    events_default: number;
    state_default: number;
    invite: number;
    kick: number;
    ban: number;
    redact: number;
    events: Record<string, number>;
}
/** #queue levels: members may post items, only the creator (the owner) may react or resolve. */
declare function queuePowerLevels(): PowerLevels;
interface BootstrapQueueOptions {
    /** Full alias, e.g. `#queue:chat.example.org`. */
    alias: string;
    mirrorUserIds: string[];
    name?: string;
}
/**
 * Creates the owner's #queue at the server's default room version (v12), so the owner is creator.
 * An alias that already resolves returns its room id unchanged.
 */
declare function bootstrapQueueRoom(owner: AppserviceClient, options: BootstrapQueueOptions): Promise<string>;

interface RegistrationOptions {
    id: string;
    asToken: string;
    hsToken: string;
    /** Where the homeserver pushes transactions; null for a receive-only edge that pulls with /sync. */
    url: string | null;
    senderLocalpart: string;
    /** Machine name inside the namespace: `edge1` owns `@ac-edge1-.*`. */
    machine: string;
    serverName: string;
}
declare function escapeRegex(text: string): string;
declare function machineUserRegex(machine: string, serverName: string): string;
declare function renderRegistration(options: RegistrationOptions): string;

export { AppserviceClient, type AppserviceClientOptions, type BootstrapQueueOptions, ContentTooLargeError, type FetchLike, type FoldContext, ITEM_KEY, ITEM_KINDS, ITEM_VERSION, type ItemContent, type ItemInput, type ItemKind, MAX_CONTENT_BYTES, MatrixError, type MatrixEvent, type MessagesOptions, type MessagesPage, type PowerLevels, REDACTED_LINE, RESOLUTION_EVENT, type RegistrationOptions, type Resolution, type Session, type SyncBatch, type SyncOptions, TRUNCATED_LINE, type TitanItem, type Verdict, assertSendable, bootstrapQueueRoom, contentBytes, decodeItem, encodeItem, escapeRegex, foldResolution, loginPassword, machineUserRegex, queuePowerLevels, renderItemBody, renderRegistration, stripReplyFallback };
