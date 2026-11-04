import { SessionIdentityError, TranscriptParseError } from "@titan-design/session-read";

/** Bad file contents (malformed JSON, a record from another session) quarantine a source and a vanished file marks it missing; anything else is a bug or a store fault and must propagate. */
export function unreadableStatus(err: unknown): "missing" | "quarantined" | null {
  if (err instanceof TranscriptParseError || err instanceof SessionIdentityError) return "quarantined";
  if (hasErrorCode(err, "ENOENT")) return "missing";
  return null;
}

export function hasErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}
