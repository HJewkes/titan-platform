import { TranscriptParseError } from "@titan-design/session-read";

/** Decoder and parse failures quarantine a source and a vanished file marks it missing; anything else is a bug or a store fault and must propagate. */
export function unreadableStatus(err: unknown): "missing" | "quarantined" | null {
  if (err instanceof TranscriptParseError) return "quarantined";
  if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return "missing";
  return null;
}
