import type { CommandMap, JsonEnvelope } from "@titan-design/rpc-protocol";
import type { CallOptions, DataSource, EventHandlers, Subscription } from "./data-source.js";

/** A failed call: the envelope's message plus its sysexits `code`, and the command that failed. */
export class RpcError extends Error {
  constructor(
    readonly command: string,
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Args may be left out only when the command accepts an empty object. */
export type CallArgs<A> = Record<string, never> extends A ? [args?: A, options?: CallOptions] : [args: A, options?: CallOptions];

type DeclaredNames<M> = keyof { [K in keyof M as string extends K ? never : K]: M[K] } & string;

/** The map's declared names; an `interface extends CommandMap` would otherwise admit any string. */
export type CommandName<M extends CommandMap> = [DeclaredNames<M>] extends [never] ? keyof M & string : DeclaredNames<M>;

export interface RpcClient<M extends CommandMap> {
  /** Resolves to the command's result; rejects with `RpcError` on a failure envelope. */
  call<K extends CommandName<M>>(name: K, ...rest: CallArgs<M[K]["args"]>): Promise<M[K]["result"]>;
  subscribe(handlers: EventHandlers, options?: CallOptions): Subscription;
  readonly source: DataSource;
}

export function createRpcClient<M extends CommandMap>(source: DataSource): RpcClient<M> {
  return {
    source,
    async call(name, ...[args, options]) {
      const envelope = (await source.call(name, args, options)) as JsonEnvelope<M[typeof name]["result"]>;
      if (!envelope.ok) throw new RpcError(name, envelope.error, envelope.code);
      return envelope.data;
    },
    subscribe: (handlers, options) => source.subscribe(handlers, options),
  };
}
