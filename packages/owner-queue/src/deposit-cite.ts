import { quoteInText } from "@titan-design/evidence";
import type { LocatorCite } from "./schema.js";

/** One transcript line: `byteLength` bytes at `byteOffset` of the session's transcript. */
export interface SessionEventRef {
  session: string;
  byteOffset: number;
  byteLength: number;
}

/** The text of one transcript event, or null when it cannot be read. `@titan-design/session-read`'s readSessionEventText fits. */
export type SessionEventTextSource = (ref: SessionEventRef) => Promise<string | null>;

/** Thrown before anything is written, when a locator cite's quote is not checked true against its event. */
export class DepositCiteError extends Error {
  constructor(readonly refusal: string) {
    super(`deposit refused: ${refusal}`);
    this.name = "DepositCiteError";
  }
}

function eventRef({ session, event }: LocatorCite): SessionEventRef {
  const [byteOffset, byteLength] = event.split(":").map(Number) as [number, number];
  return { session, byteOffset, byteLength };
}

/**
 * Checks a locator cite's quote against its transcript event; free text and no cite pass
 * unchecked. Detail names the session and event the caller sent, never the event's text.
 */
export async function verifyDepositCite(cite: string | LocatorCite | undefined, events: SessionEventTextSource | undefined): Promise<void> {
  if (cite === undefined || typeof cite === "string") return;
  const at = `cite ${cite.session} ${cite.event}`;
  if (!events) throw new DepositCiteError(`${at}: no session event source to check the quote against`);
  const text = await events(eventRef(cite));
  if (text === null) throw new DepositCiteError(`${at}: the event could not be read`);
  const found = quoteInText(text, cite.quote);
  if (found === null) throw new DepositCiteError(`${at}: the quote is empty`);
  if (!found) throw new DepositCiteError(`${at}: the quote does not match the event text`);
}
