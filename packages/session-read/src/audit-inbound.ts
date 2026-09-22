import type { LineContext, LineReader } from "./line-reader.js";
import { classifyInbound, type Inbound } from "./wake-cause.js";

/**
 * One `inbound` per delivering record: a `user` line, or a `queued_command`
 * attachment that landed mid-loop. Returned so the context emitter labels the
 * same record by the same cause.
 */
export function emitInbound(reader: LineReader, ctx: LineContext): Inbound {
  const inbound = classifyInbound(ctx.line);
  reader.emit({ ...reader.base(ctx), kind: "inbound", blockIndex: 0, ...inbound });
  return inbound;
}
