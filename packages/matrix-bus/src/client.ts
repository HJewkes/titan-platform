import { matrixRequest, MatrixError, type FetchLike, type RequestOptions } from "./http.js";
import { assertSendable } from "./size.js";
import { syncBatches, type SyncOptions, type SyncResponse } from "./sync.js";
import type { MatrixEvent, MessagesPage, Session, SyncBatch } from "./types.js";

export interface AppserviceClientOptions {
  baseUrl: string;
  asToken: string;
  /** The user to act as; masquerades with ?user_id= unless it equals `sender`. */
  userId?: string;
  /** The user the token itself belongs to, when known (the appservice sender or a password session). */
  sender?: string;
  fetch?: FetchLike;
}

export interface MessagesOptions {
  from?: string;
  dir?: "b" | "f";
  limit?: number;
}

const CLIENT = "/_matrix/client/v3";
const room = (roomId: string) => `${CLIENT}/rooms/${encodeURIComponent(roomId)}`;

function newTxnPrefix(): string {
  return globalThis.crypto.randomUUID();
}

export class AppserviceClient {
  readonly userId: string | undefined;
  private readonly txnPrefix = newTxnPrefix();
  private txnCounter = 0;

  constructor(private readonly options: AppserviceClientOptions) {
    this.userId = options.userId ?? options.sender;
  }

  private get masqueradeAs(): string | undefined {
    const { userId, sender } = this.options;
    return userId && userId !== sender ? userId : undefined;
  }

  request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const { baseUrl, asToken, fetch } = this.options;
    const query = { ...options.query, user_id: this.masqueradeAs };
    return matrixRequest<T>({ baseUrl, fetch }, method, path, { ...options, token: asToken, query });
  }

  private nextTxnId(): string {
    this.txnCounter += 1;
    return `${this.txnPrefix}-${this.txnCounter}`;
  }

  async send(roomId: string, type: string, content: Record<string, unknown>, txnId = this.nextTxnId()): Promise<{ event_id: string }> {
    assertSendable(content);
    const path = `${room(roomId)}/send/${encodeURIComponent(type)}/${encodeURIComponent(txnId)}`;
    return this.request("PUT", path, { body: content });
  }

  async sendState(roomId: string, type: string, stateKey: string, content: Record<string, unknown>): Promise<{ event_id: string }> {
    assertSendable(content);
    const path = `${room(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`;
    return this.request("PUT", path, { body: content });
  }

  state(roomId: string): Promise<MatrixEvent[]> {
    return this.request("GET", `${room(roomId)}/state`);
  }

  messages(roomId: string, { from, dir = "b", limit }: MessagesOptions = {}): Promise<MessagesPage> {
    const query = { from, dir, limit: limit === undefined ? undefined : String(limit) };
    return this.request("GET", `${room(roomId)}/messages`, { query });
  }

  whoami(): Promise<{ user_id: string; device_id?: string }> {
    return this.request("GET", `${CLIENT}/account/whoami`);
  }

  joinRoom(roomIdOrAlias: string): Promise<{ room_id: string }> {
    return this.request("POST", `${CLIENT}/join/${encodeURIComponent(roomIdOrAlias)}`, { body: {} });
  }

  /** Registers a namespace user; an existing user is not an error. */
  async register(localpart: string): Promise<void> {
    const body = { type: "m.login.application_service", username: localpart, inhibit_login: true };
    try {
      await this.request("POST", `${CLIENT}/register`, { body });
    } catch (err) {
      if (!(err instanceof MatrixError && err.errcode === "M_USER_IN_USE")) throw err;
    }
  }

  async loginAs(localpart: string): Promise<Session> {
    const body = { type: "m.login.application_service", identifier: { type: "m.id.user", user: localpart } };
    const res = await this.request<LoginResponse>("POST", `${CLIENT}/login`, { body });
    return toSession(res);
  }

  /** Yields one batch per /sync response; persist `since` from each batch before handling its events. */
  syncLoop(options: SyncOptions = {}): AsyncGenerator<SyncBatch> {
    const request = (query: Record<string, string | undefined>, signal?: AbortSignal) =>
      this.request<SyncResponse>("GET", `${CLIENT}/sync`, { query, signal });
    return syncBatches(request, options);
  }
}

interface LoginResponse {
  user_id: string;
  access_token: string;
  device_id?: string;
}

function toSession(res: LoginResponse): Session {
  return { userId: res.user_id, accessToken: res.access_token, deviceId: res.device_id };
}

/** Logs in an ordinary account; the password is used once and not kept. */
export async function loginPassword(baseUrl: string, user: string, password: string, fetch?: FetchLike): Promise<AppserviceClient> {
  const body = { type: "m.login.password", identifier: { type: "m.id.user", user }, password };
  const res = await matrixRequest<LoginResponse>({ baseUrl, fetch }, "POST", `${CLIENT}/login`, { body });
  return new AppserviceClient({ baseUrl, asToken: res.access_token, sender: res.user_id, fetch });
}
