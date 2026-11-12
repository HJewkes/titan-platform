import { createHash } from "node:crypto";
import path from "node:path";
import { checkOwnerFile, type FileFacts, type OwnerFileContext } from "./file-checks.js";
import { parseSeat, parseSeatIndex } from "./parse.js";
import { refuse, type SeatResult } from "./refusal.js";
import type { SeatDefinition, SeatIndex } from "./schema.js";

/**
 * What a reader saw for one owner-held file: the absolute path it opened, the `lstat` facts and
 * the bytes, or the error that stopped it. Anything missing is a refusal, never "no seat".
 */
export interface OwnerFileRead {
  path: string;
  facts?: FileFacts;
  content?: string | Uint8Array;
  error?: string;
}

export interface LoadSeatInput {
  /** The seat name the launch targets. */
  name: string;
  seat: OwnerFileRead;
  index: OwnerFileRead;
  /** The prompt file named by the definition, read from beside it. */
  prompt: Pick<OwnerFileRead, "content" | "error">;
  context: OwnerFileContext;
}

export const SEAT_FILE_SUFFIX = ".seat.json";

export type LoadedSeat = SeatResult<{ seat: SeatDefinition; seatHash: string }>;

const sha256 = (content: string | Uint8Array): string => createHash("sha256").update(content).digest("hex");

const asText = (content: string | Uint8Array): string =>
  typeof content === "string" ? content : new TextDecoder("utf-8", { fatal: false }).decode(content);

function checkedText(read: OwnerFileRead, ctx: OwnerFileContext): SeatResult<{ text: string; hash: string }> {
  if (read.error !== undefined || read.facts === undefined || read.content === undefined) {
    return refuse("unreadable", `${read.path}: ${read.error ?? "no file facts or content"}`);
  }
  const unsafe = checkOwnerFile(read.path, read.facts, ctx);
  if (unsafe !== undefined) return { ok: false, refusal: unsafe };
  return { ok: true, text: asText(read.content), hash: sha256(read.content) };
}

function loadIndex(input: LoadSeatInput): SeatResult<{ index: SeatIndex }> {
  const read = checkedText(input.index, input.context);
  return read.ok ? parseSeatIndex(read.text) : read;
}

function checkPrompt(seat: SeatDefinition, prompt: LoadSeatInput["prompt"]): SeatResult<object> {
  if (prompt.error !== undefined || prompt.content === undefined) {
    return refuse("prompt_unreadable", `${seat.prompt.path}: ${prompt.error ?? "no content"}`);
  }
  const actual = sha256(prompt.content);
  if (actual !== seat.prompt.sha256) {
    return refuse("prompt_hash_mismatch", `${seat.prompt.path} hashes to ${actual}, the seat pins ${seat.prompt.sha256}`);
  }
  return { ok: true };
}

function checkListed(seat: SeatDefinition, index: SeatIndex): SeatResult<object> {
  if (index.seats.includes(seat.name)) return { ok: true };
  return refuse("not_in_index", `${seat.name} is not listed in the seat index`);
}

/** Owner-only reads are honoured for the one seat the owner lists in the index, and refused for any other. */
function checkOwnerOnlyRead(seat: SeatDefinition, index: SeatIndex): SeatResult<object> {
  if (seat.ownerOnlyRead !== true || index.ownerOnlyReaders.includes(seat.name)) return { ok: true };
  return refuse("owner_only_read_not_listed", `${seat.name} sets ownerOnlyRead but the index lists ${index.ownerOnlyReaders.join(", ") || "no reader"}`);
}

/** Every check a launch path must pass before it may use a seat definition, in fail-closed order. */
export function loadSeat(input: LoadSeatInput): LoadedSeat {
  const fileName = path.posix.basename(input.seat.path);
  if (fileName !== `${input.name}${SEAT_FILE_SUFFIX}`) {
    return refuse("name_mismatch", `${fileName} is not ${input.name}${SEAT_FILE_SUFFIX}`);
  }
  const index = loadIndex(input);
  if (!index.ok) return index;
  const read = checkedText(input.seat, input.context);
  if (!read.ok) return read;
  const parsed = parseSeat(read.text, input.name);
  if (!parsed.ok) return parsed;
  const listed = checkListed(parsed.seat, index.index);
  if (!listed.ok) return listed;
  const prompt = checkPrompt(parsed.seat, input.prompt);
  if (!prompt.ok) return prompt;
  const reader = checkOwnerOnlyRead(parsed.seat, index.index);
  if (!reader.ok) return reader;
  return { ok: true, seat: parsed.seat, seatHash: read.hash };
}
