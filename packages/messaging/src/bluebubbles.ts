import type {
  MessageTransport,
  SendError,
  SendInput,
  SendResult,
} from "./contract.js";
import { sendFailed } from "./contract.js";

export interface BlueBubblesConfig {
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

const SEND_PATH = "/api/v1/message/text";

/** Every string that leaves this module passes through here. */
export function redactPassword(value: string, password: string): string {
  if (!password) return value;
  const encoded = encodeURIComponent(password);
  const once = value.split(password).join("***");
  return encoded === password ? once : once.split(encoded).join("***");
}

export function apiUrl(config: BlueBubblesConfig, path: string): string {
  const url = new URL(config.baseUrl.replace(/\/+$/, "") + path);
  url.searchParams.set("password", config.password);
  return url.toString();
}

export function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  return String(cause);
}

/** A BlueBubbles envelope: `{ status, message, data }`, or `error.message` on failure. */
async function readEnvelope(
  response: Response,
): Promise<{ message?: string; guid?: string }> {
  try {
    const body = (await response.json()) as {
      message?: unknown;
      error?: { message?: unknown };
      data?: { guid?: unknown };
    };
    const message = body.error?.message ?? body.message;
    return {
      message: typeof message === "string" ? message : undefined,
      guid: typeof body.data?.guid === "string" ? body.data.guid : undefined,
    };
  } catch {
    return {};
  }
}

function errorForStatus(
  status: number,
  message: string,
  handle: string,
): SendError {
  if (status === 401 || status === 403) return { kind: "unauthorized", message };
  if (status === 404) return { kind: "no-chat", handle, message };
  if (status >= 400 && status < 500) return { kind: "rejected", status, message };
  return { kind: "unknown", message: `HTTP ${status}: ${message}` };
}

/**
 * Sends over the BlueBubbles Server REST API with `fetch` only, so the same
 * code runs in a Worker, a daemon, and a test.
 */
export class BlueBubblesTransport implements MessageTransport {
  private readonly doFetch: typeof fetch;

  constructor(private readonly config: BlueBubblesConfig) {
    this.doFetch = config.fetch ?? globalThis.fetch;
  }

  async send({ handle, text }: SendInput): Promise<SendResult> {
    const chatGuid = await this.resolveChatGuid(handle);
    if (chatGuid.kind !== "ok") return sendFailed(chatGuid.error);

    let response: Response;
    try {
      response = await this.postText(chatGuid.value, text);
    } catch (cause) {
      return sendFailed({
        kind: "unreachable",
        message: this.redact(describeCause(cause)),
      });
    }

    const envelope = await readEnvelope(response);
    const message = this.redact(envelope.message ?? response.statusText);
    if (!response.ok) {
      return sendFailed(errorForStatus(response.status, message, handle));
    }
    return { ok: true, messageGuid: envelope.guid };
  }

  private async postText(chatGuid: string, text: string): Promise<Response> {
    return await this.doFetch(apiUrl(this.config, SEND_PATH), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatGuid,
        tempGuid: (this.config.newTempGuid ?? (() => crypto.randomUUID()))(),
        message: text,
        method: "apple-script",
      }),
    });
  }

  private async resolveChatGuid(
    handle: string,
  ): Promise<{ kind: "ok"; value: string } | { kind: "err"; error: SendError }> {
    let guid: string | undefined;
    try {
      guid = await this.config.chatGuidFor(handle);
    } catch (cause) {
      return {
        kind: "err",
        error: { kind: "unknown", message: this.redact(describeCause(cause)) },
      };
    }
    if (guid) return { kind: "ok", value: guid };
    return {
      kind: "err",
      error: {
        kind: "no-chat",
        handle,
        message: "No chatGuid for handle; an existing conversation is required",
      },
    };
  }

  private redact(value: string): string {
    return redactPassword(value, this.config.password);
  }
}

export function createBlueBubblesTransport(
  config: BlueBubblesConfig,
): MessageTransport {
  return new BlueBubblesTransport(config);
}
