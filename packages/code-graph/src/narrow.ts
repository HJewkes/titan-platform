import { isRecord } from "@titan-design/rpc-protocol/narrow";

/** A thrown value's `code`, as Node's system errors set it. */
export function errnoCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}
