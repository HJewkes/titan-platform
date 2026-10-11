import { z } from 'zod';

/**
 * The transport seam. Everything downstream of it (schedulers, protocol state
 * machines, composers) depends on this file and never on a vendor SDK.
 */
/** `data` comes back verbatim when the button is tapped; its format is the consumer's. */
interface Button {
    label: string;
    data: string;
    /** Rendered only by a channel whose `buttonStates` is true; elsewhere it is ignored. */
    state?: "disabled";
    style?: "primary" | "success" | "danger";
}
type ButtonRow = Button[];
/** The address iMessage routes to: a phone number or an email. */
interface SendInput {
    handle: string;
    text: string;
    /** Channel-neutral rows of tappable buttons; a transport without them ignores this. */
    buttons?: ButtonRow[];
}
/**
 * Why a send did not happen. `no-chat` is its own case because iMessage cannot
 * open a conversation from an API call: a human has to send the first message.
 * `too-long` is its own case so a composer can split rather than retry.
 * `unreachable` means the request provably never left, so a retry cannot
 * duplicate it; `indeterminate` means it may have been delivered, so a retry can.
 * `rate-limited` is its own case so a consumer backs off instead of re-deriving
 * "status 429 means retry"; `retryAfterSeconds` is absent when the server named
 * no wait, and the package never invents one.
 */
type SendError = {
    kind: "unreachable";
    message: string;
} | {
    kind: "indeterminate";
    message: string;
} | {
    kind: "unauthorized";
    message: string;
} | {
    kind: "no-chat";
    handle: string;
    message: string;
} | {
    kind: "too-long";
    limit: number;
    length: number;
    message: string;
} | {
    kind: "rejected";
    status: number;
    message: string;
} | {
    kind: "rate-limited";
    retryAfterSeconds?: number;
    message: string;
} | {
    kind: "bad-buttons";
    message: string;
} | {
    kind: "unknown";
    message: string;
};
type ChannelId = "telegram" | "imessage" | "mock";
/**
 * Plain JSON. A product stores it as is and hands it back for an edit or a
 * reaction. It holds the resolved chat because a Telegram `messageId` is only
 * unique within one chat, so the pair is the identity and the key a message
 * store should use.
 */
interface MessageRef {
    channel: ChannelId;
    chat: string;
    messageId: string;
    threadId?: string;
}
/**
 * `ok: true` means the server accepted the message for sending. There is no
 * delivered or read signal: those need the Private API, which is out of scope.
 * `ref` is absent when the server accepted the message without naming it.
 */
type SendResult = {
    ok: true;
    /** @deprecated Use `ref`. A bare id cannot address a Telegram message. */
    messageGuid?: string;
    ref?: MessageRef;
} | {
    ok: false;
    error: SendError;
};
interface MessageTransport {
    send(input: SendInput): Promise<SendResult>;
}
declare function sendFailed(error: SendError): SendResult;
/** The strongest signal the channel can ever report back about a sent message. */
type DeliveryCeiling = "accepted" | "delivered" | "read";
/**
 * A static answer to "can this channel ever do this", so a caller picks a
 * degrade path before it calls. It never promises one call will succeed: a flag
 * is true only when the shipped adapter implements the thing today.
 */
interface ChannelCapabilities {
    channel: ChannelId;
    maxTextLength?: number;
    /** Whether the bot can open a conversation with no prior message from the person. */
    canInitiate: boolean;
    deliveryCeiling: DeliveryCeiling;
    buttons: boolean;
    buttonStates: boolean;
    edits: boolean;
    reactions: boolean;
    chatActions: boolean;
    drafts: boolean;
    draftStreaming: boolean;
    threads: boolean;
}
/**
 * `unsupported` sits outside `SendError` so an exhaustive switch over send
 * failures breaks once for `rate-limited` and not twice.
 */
type InteractionError = SendError | {
    kind: "unsupported";
    capability: keyof ChannelCapabilities;
    message: string;
} | {
    kind: "message-gone";
    message: string;
};
/** `changed: false` is success: the message already read the way the caller asked for. */
type InteractionResult = {
    ok: true;
    changed: boolean;
} | {
    ok: false;
    error: InteractionError;
};
interface EditInput {
    ref: MessageRef;
    text?: string;
    buttons?: ButtonRow[] | "remove";
}
/**
 * The acknowledgement half of a channel, kept apart from `MessageTransport` so
 * a consumer's own one-method fake still satisfies the send contract. No method
 * here ever throws.
 */
interface InteractiveTransport extends MessageTransport {
    readonly capabilities: ChannelCapabilities;
    react(input: {
        to: MessageRef;
        emoji: string | null;
    }): Promise<InteractionResult>;
    chatAction(input: {
        handle: string;
        action: "typing";
        threadId?: string;
    }): Promise<InteractionResult>;
    edit(input: EditInput): Promise<InteractionResult>;
    answerAction(input: {
        actionId: string;
        toast?: string;
    }): Promise<InteractionResult>;
}
/** Injected time, so a keep-alive loop is testable without a real wait. */
interface Scheduler {
    now(): number;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

interface BlueBubblesConfig {
    /** Origin of the BlueBubbles server, e.g. `http://127.0.0.1:1234`. */
    baseUrl: string;
    /** Server password. Passed as the `password` query parameter, never logged. */
    password: string;
    /** iMessage cannot start a conversation, so the chat GUID comes from outside. */
    chatGuidFor: (handle: string) => string | undefined | Promise<string | undefined>;
    fetch?: typeof fetch;
    /** The server rejects an AppleScript send without one; overridable for tests. */
    newTempGuid?: () => string;
}
/** Every string that leaves this module passes through here. */
declare function redactPassword(value: string, password: string): string;
/**
 * Sends over the BlueBubbles Server REST API with `fetch` only, so the same
 * code runs in a Worker, a daemon, and a test.
 */
declare class BlueBubblesTransport implements InteractiveTransport {
    private readonly config;
    readonly capabilities: ChannelCapabilities;
    private readonly doFetch;
    constructor(config: BlueBubblesConfig);
    /** Every interaction answers without a request, so a caller can degrade before it calls. */
    react(): Promise<InteractionResult>;
    chatAction(): Promise<InteractionResult>;
    edit(): Promise<InteractionResult>;
    answerAction(): Promise<InteractionResult>;
    /** `buttons` is ignored: iMessage has no inline keyboards, so only the text goes. */
    send({ handle, text }: SendInput): Promise<SendResult>;
    private resultFor;
    /** The server forgets a tempGuid once its send settles, so a fresh one per call costs no safety. */
    private textRequest;
    private resolveChatGuid;
    private redact;
}
declare function createBlueBubblesTransport(config: BlueBubblesConfig): InteractiveTransport;

interface RecordedSend {
    handle: string;
    text: string;
    buttons?: ButtonRow[];
    at: number;
}
type MockEvent = {
    type: "send";
    at: number;
    handle: string;
    text: string;
    buttons?: ButtonRow[];
    ref: MessageRef;
} | {
    type: "react";
    at: number;
    to: MessageRef;
    emoji: string | null;
} | {
    type: "chatAction";
    at: number;
    handle: string;
    action: "typing";
} | {
    type: "edit";
    at: number;
    ref: MessageRef;
    text?: string;
    buttons?: ButtonRow[] | "remove";
} | {
    type: "answer";
    at: number;
    actionId: string;
    toast?: string;
};
interface MockOptions {
    now?: () => number;
    capabilities?: Partial<ChannelCapabilities>;
}
interface MockMessage {
    text: string;
    buttons?: ButtonRow[];
    reaction?: string;
}
/** What Telegram shows a typing action for, so `typingVisible` needs no real wait. */
declare const MOCK_TYPING_VISIBLE_MS = 5000;
/**
 * In-memory transport for consumers that need to exercise retry, ceiling and
 * acknowledgement logic without an Apple ID, a second macOS user, or a
 * BlueBubbles server. It keeps every message it sent, so a later edit or
 * reaction has a target and a test can read what the person would see.
 */
declare class MockTransport implements InteractiveTransport {
    readonly sent: RecordedSend[];
    readonly log: MockEvent[];
    readonly capabilities: ChannelCapabilities;
    private readonly now;
    private readonly scripted;
    private readonly messages;
    private readonly typingUntil;
    /** The bare clock form is what 0.3.0 consumers pass, so it still works. */
    constructor(options?: (() => number) | MockOptions);
    /** Queue one failure, optionally only for one method. Calls consume the queue in order. */
    failNext(error: InteractionError, on?: MockEvent["type"]): void;
    reset(): void;
    messageAt(ref: MessageRef): MockMessage | undefined;
    typingVisible(handle: string): boolean;
    /** An attempt is recorded even when it is scripted to fail. */
    send({ handle, text, buttons }: SendInput): Promise<SendResult>;
    react({ to, emoji }: {
        to: MessageRef;
        emoji: string | null;
    }): Promise<InteractionResult>;
    chatAction({ handle, action, }: {
        handle: string;
        action: "typing";
        threadId?: string;
    }): Promise<InteractionResult>;
    edit({ ref, text, buttons }: EditInput): Promise<InteractionResult>;
    answerAction({ actionId, toast, }: {
        actionId: string;
        toast?: string;
    }): Promise<InteractionResult>;
    /** A capability turned off answers `unsupported` before any scripted failure is consumed. */
    private refuse;
    /** A failure scoped to one method is skipped by every other, so the queue stays in order. */
    private take;
}
/**
 * A `Scheduler` whose time only moves when a test moves it, so a keep-alive
 * loop is exercised in milliseconds rather than seconds.
 */
declare class ManualClock implements Scheduler {
    private current;
    private waiters;
    constructor(start?: number);
    now(): number;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
    /** Awaiting the result lets whatever the sleepers do next run before the test asserts. */
    advance(ms: number): Promise<void>;
}

interface TelegramConfig {
    /** Bot token from BotFather. It sits in the URL path, so it is redacted everywhere. */
    token: string;
    /** A bot cannot message a chat it has never seen, so the chat id comes from outside. */
    chatIdFor: (handle: string) => string | number | undefined | Promise<string | number | undefined>;
    fetch?: typeof fetch;
    /** Override for a local Bot API server. Defaults to the cloud one. */
    baseUrl?: string;
    /** Off until spike S5 confirms the wire format; on, `state` and `style` are sent. */
    buttonStates?: boolean;
}
/** `sendMessage` documents `text` as 1-4096 characters after entities parsing. */
declare const TELEGRAM_MAX_TEXT_LENGTH = 4096;
/** `callback_data` is documented as 1-64 bytes, and Telegram counts UTF-8 bytes. */
declare const TELEGRAM_MAX_CALLBACK_DATA_BYTES = 64;
/** Every string that leaves this module passes through here. */
declare function redactToken(value: string, token: string): string;
/** The Bot API envelope: `{ ok, result }`, or `{ ok: false, description }`. */
interface TelegramEnvelope {
    ok: boolean;
    result?: unknown;
    description?: string;
    errorCode?: number;
    parameters?: {
        retryAfterSeconds?: number;
        migrateToChatId?: number;
    };
}
/** A wait longer than this is clamped: the wait is real, only its size is untrusted. */
declare const TELEGRAM_MAX_RETRY_AFTER_SECONDS = 86400;

/**
 * Sends over the Telegram Bot API with `fetch` only, so the same code runs in a
 * Worker, a daemon, and a test. No `parse_mode`: coach copy is sent verbatim.
 */
declare class TelegramTransport implements InteractiveTransport {
    private readonly config;
    readonly capabilities: ChannelCapabilities;
    constructor(config: TelegramConfig);
    send(input: SendInput): Promise<SendResult>;
    /** A second call replaces the mark, so a product can swap "seen" for "done". */
    react({ to, emoji }: {
        to: MessageRef;
        emoji: string | null;
    }): Promise<InteractionResult>;
    /** Telegram shows it for five seconds or until the bot's next message; keeping it alive is the caller's job. */
    chatAction({ handle, action, threadId, }: {
        handle: string;
        action: "typing";
        threadId?: string;
    }): Promise<InteractionResult>;
    edit(input: EditInput): Promise<InteractionResult>;
    answerAction({ actionId, toast, }: {
        actionId: string;
        toast?: string;
    }): Promise<InteractionResult>;
    private interact;
    private resolveChatId;
    private redact;
}
declare function createTelegramTransport(config: TelegramConfig): InteractiveTransport;

/** The Update shapes this package reads: a text message, or a tapped inline button. */
declare const telegramUpdateEvent: z.ZodObject<{
    update_id: z.ZodNumber;
    message: z.ZodOptional<z.ZodObject<{
        message_id: z.ZodNumber;
        date: z.ZodNumber;
        text: z.ZodOptional<z.ZodString>;
        from: z.ZodOptional<z.ZodObject<{
            id: z.ZodNumber;
        }, z.core.$strip>>;
        chat: z.ZodObject<{
            id: z.ZodNumber;
        }, z.core.$strip>;
        message_thread_id: z.ZodOptional<z.ZodNumber>;
        reply_to_message: z.ZodOptional<z.ZodObject<{
            message_id: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    callback_query: z.ZodOptional<z.ZodObject<{
        id: z.ZodString;
        from: z.ZodObject<{
            id: z.ZodNumber;
        }, z.core.$strip>;
        message: z.ZodOptional<z.ZodObject<{
            message_id: z.ZodNumber;
            chat: z.ZodObject<{
                id: z.ZodNumber;
            }, z.core.$strip>;
            date: z.ZodNumber;
            text: z.ZodOptional<z.ZodString>;
            message_thread_id: z.ZodOptional<z.ZodNumber>;
            reply_markup: z.ZodOptional<z.ZodObject<{
                inline_keyboard: z.ZodArray<z.ZodArray<z.ZodObject<{
                    text: z.ZodString;
                    callback_data: z.ZodOptional<z.ZodString>;
                }, z.core.$strip>>>;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
        data: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
interface TelegramTextUpdate {
    updateId: number;
    chatId: number;
    fromId: number;
    /** Required: nothing can react to or edit a message it cannot address. */
    messageId: number;
    text: string;
    date: number;
    threadId?: number;
    replyToMessageId?: number;
}
/** A tapped inline button; `data` is the button's callback data, verbatim. */
interface TelegramCallback {
    kind: "callback";
    updateId: number;
    chatId: number;
    fromId: number;
    callbackQueryId: string;
    messageId: number;
    data: string;
    date: number;
    threadId?: number;
    messageText?: string;
    /** The tapped prompt's own keyboard, so a receipt needs no store of what was sent. */
    buttons?: ButtonRow[];
}
type TelegramInbound = ({
    kind: "text";
} & TelegramTextUpdate) | TelegramCallback;
interface PollUpdatesOptions {
    /** Passed straight to getUpdates; 0 is short polling and is for tests only. */
    timeoutSeconds: number;
    allowedChatIds: readonly (string | number)[];
    signal?: AbortSignal;
}
/** The user's own message for a typed update, the tapped prompt for a tap. */
declare function refOfInbound(update: TelegramInbound): MessageRef;
/**
 * Long-polls getUpdates forever, yielding only text messages and button taps
 * from an allowed chat. Anything else (a photo, an edit, a stranger, a shape
 * this package does not read) is acknowledged and skipped, never thrown. Abort
 * the signal to stop.
 */
declare function pollUpdates(config: TelegramConfig, { timeoutSeconds, allowedChatIds, signal }: PollUpdatesOptions): AsyncGenerator<TelegramInbound>;
/**
 * One short poll, for the human's one-time "what is my chat id" step. It passes
 * no offset, so it confirms nothing and the daemon still sees these updates.
 */
declare function readChatIds(config: TelegramConfig): Promise<number[]>;
/** `error` carries the same typed failure a send would report, so a 429 here is backed off, not parsed. */
type AnswerCallbackResult = {
    ok: true;
} | {
    ok: false;
    reason: string;
    error: SendError;
};
/**
 * Stops the tapped button's loading spinner; Telegram expects this for every
 * callback. `text`, when given, shows as a brief toast. Never throws.
 */
declare function answerCallbackQuery(config: TelegramConfig, callbackQueryId: string, text?: string): Promise<AnswerCallbackResult>;

/**
 * Raw Bot API JSON, not a parsed update: a test feeds these to the same
 * `readInbound` or `validateTelegramWebhook` a real door calls, so the parser
 * is exercised rather than bypassed.
 */
declare function fakeTextUpdate(fields?: Partial<TelegramTextUpdate>): unknown;
declare function fakeCallbackUpdate(fields?: Partial<TelegramCallback>): unknown;

/**
 * Dedupe storage, injected. The package ships only the in-memory
 * implementation so it needs no database and stays runtime-neutral.
 */
interface SeenStore {
    has(guid: string): Promise<boolean> | boolean;
    add(guid: string): Promise<void> | void;
}
declare class MemorySeenStore implements SeenStore {
    private readonly guids;
    has(guid: string): boolean;
    add(guid: string): void;
}
type InboundRejection = "bad-secret" | "sender-not-allowed" | "duplicate" | "too-long" | "from-me" | "malformed";
type InboundResult = {
    status: "accepted";
    handle: string;
    guid: string;
    text: string;
} | {
    status: "rejected";
    reason: InboundRejection;
};
/** The `new-message` webhook body: WebhookService posts `{ type, data }`. */
declare const newMessageEvent: z.ZodObject<{
    type: z.ZodLiteral<"new-message">;
    data: z.ZodObject<{
        guid: z.ZodString;
        text: z.ZodNullable<z.ZodString>;
        isFromMe: z.ZodBoolean;
        handle: z.ZodOptional<z.ZodNullable<z.ZodObject<{
            address: z.ZodString;
        }, z.core.$strip>>>;
    }, z.core.$strip>;
}, z.core.$strip>;
interface ValidateInboundInput {
    pathSecret: string;
    expectedSecret: string;
    allowedHandles: readonly string[];
    body: unknown;
    maxTextLength: number;
    seen: SeenStore;
}
/** Compares over the longer of the two, so only the length can be timed. */
declare function constantTimeEqual(a: string, b: string): boolean;
/**
 * Pure: every effect is in the injected `seen` store. BlueBubbles publishes no
 * request signature, so the secret path segment, the handle allowlist and the
 * GUID dedupe are the whole boundary.
 */
declare function validateInbound({ pathSecret, expectedSecret, allowedHandles, body, maxTextLength, seen, }: ValidateInboundInput): Promise<InboundResult>;

type Liveness = {
    state: "alive";
    serverVersion?: string;
    osVersion?: string;
    privateApi?: boolean;
} | {
    state: "dark";
    reason: "unreachable" | "unauthorized" | "timeout" | "bad-response";
};
interface ProbeOptions {
    timeoutMs: number;
}
/**
 * The heartbeat every consumer runs before sending. macOS auto-logs in one user
 * at boot, so after a reboot the coach session is dark until a human switches
 * into it: `dark` is an expected state, not an exception.
 */
declare function probeLiveness(config: BlueBubblesConfig, { timeoutMs }: ProbeOptions): Promise<Liveness>;

type TelegramRejection = "bad-secret" | "sender-not-allowed" | "duplicate" | "too-long" | "malformed" | "not-text";
type TelegramInboundResult = ({
    status: "accepted";
} & TelegramInbound) | {
    status: "rejected";
    reason: TelegramRejection;
};
interface ValidateTelegramWebhookInput {
    /** The `X-Telegram-Bot-Api-Secret-Token` header Telegram echoes from setWebhook. */
    headerSecret: string;
    expectedSecret: string;
    allowedChatIds: readonly (string | number)[];
    body: unknown;
    /** Applies to text messages; callback data is already capped at 64 bytes by Telegram. */
    maxTextLength: number;
    seen: SeenStore;
}
/**
 * Pure: every effect is in the injected `seen` store. Accepts a text message
 * or a button tap, read exactly as `pollUpdates` reads them. Telegram signs nothing,
 * so the echoed secret header, the chat allowlist and the update_id dedupe are
 * the whole boundary.
 */
declare function validateTelegramWebhook({ headerSecret, expectedSecret, allowedChatIds, body, maxTextLength, seen, }: ValidateTelegramWebhookInput): Promise<TelegramInboundResult>;

type TelegramLiveness = {
    state: "alive";
    username?: string;
    botId?: number;
} | {
    state: "dark";
    reason: "unreachable" | "unauthorized" | "timeout" | "bad-response";
};
/**
 * getMe is the documented way to test a token, so it doubles as the heartbeat:
 * it says both "the API answers" and "this token still works".
 */
declare function probeTelegramLiveness(config: TelegramConfig, { timeoutMs }: ProbeOptions): Promise<TelegramLiveness>;

type SplitBoundary = "paragraph" | "newline" | "sentence" | "whitespace";
interface SplitOptions {
    maxLength: number;
    /** Avoids a tiny trailing part. Defaults to a quarter of maxLength. */
    minLength?: number;
    /** Tried in order. Defaults to paragraph, newline, sentence, whitespace. */
    prefer?: readonly SplitBoundary[];
}
/** Splits text into parts of at most `maxLength` UTF-16 units, preferring natural boundaries. */
declare function splitText(text: string, options: SplitOptions): string[];

export { type AnswerCallbackResult, type BlueBubblesConfig, BlueBubblesTransport, type Button, type ButtonRow, type ChannelCapabilities, type ChannelId, type DeliveryCeiling, type EditInput, type InboundRejection, type InboundResult, type InteractionError, type InteractionResult, type InteractiveTransport, type Liveness, MOCK_TYPING_VISIBLE_MS, ManualClock, MemorySeenStore, type MessageRef, type MessageTransport, type MockEvent, type MockMessage, type MockOptions, MockTransport, type PollUpdatesOptions, type ProbeOptions, type RecordedSend, type Scheduler, type SeenStore, type SendError, type SendInput, type SendResult, type SplitBoundary, type SplitOptions, TELEGRAM_MAX_CALLBACK_DATA_BYTES, TELEGRAM_MAX_RETRY_AFTER_SECONDS, TELEGRAM_MAX_TEXT_LENGTH, type TelegramCallback, type TelegramConfig, type TelegramEnvelope, type TelegramInbound, type TelegramInboundResult, type TelegramLiveness, type TelegramRejection, type TelegramTextUpdate, TelegramTransport, type ValidateInboundInput, type ValidateTelegramWebhookInput, answerCallbackQuery, constantTimeEqual, createBlueBubblesTransport, createTelegramTransport, fakeCallbackUpdate, fakeTextUpdate, newMessageEvent, pollUpdates, probeLiveness, probeTelegramLiveness, readChatIds, redactPassword, redactToken, refOfInbound, sendFailed, splitText, telegramUpdateEvent, validateInbound, validateTelegramWebhook };
