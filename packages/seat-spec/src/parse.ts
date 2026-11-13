import type { z } from "zod";
import { refuse, type SeatRefusal, type SeatResult } from "./refusal.js";
import {
  BYPASS_PERMISSION_MODES,
  SEAT_INDEX_SCHEMA,
  SEAT_SCHEMA,
  seatIndexSchema,
  seatSchema,
  type SeatDefinition,
  type SeatIndex,
} from "./schema.js";

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function readJson(text: string): SeatResult<{ raw: Raw }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return refuse("malformed_json", err instanceof Error ? err.message : String(err));
  }
  return isRecord(parsed) ? { ok: true, raw: parsed } : refuse("not_an_object", "the file is not a JSON object");
}

function valueAt(raw: Raw, path: readonly PropertyKey[]): unknown {
  let node: unknown = raw;
  for (const key of path) {
    if (Array.isArray(node) && typeof key === "number") node = node[key];
    else node = isRecord(node) && typeof key === "string" ? node[key] : undefined;
  }
  return node;
}

const dotted = (path: readonly PropertyKey[]): string => path.map(String).join(".");

/** One named refusal for the first zod issue: unknown and missing fields are named, never defaulted. */
function refusalOf(raw: Raw, issue: z.core.$ZodIssue): SeatRefusal {
  if (issue.code === "unrecognized_keys") {
    return { code: "unknown_field", detail: issue.keys.map((key) => dotted([...issue.path, key])).join(", ") };
  }
  const field = dotted(issue.path);
  if (valueAt(raw, issue.path) === undefined) return { code: "missing_field", detail: field };
  return { code: "invalid_field", detail: `${field}: ${issue.message}` };
}

function postureRefusal(raw: Raw): SeatRefusal | undefined {
  const mode = raw.permissionMode;
  if ((BYPASS_PERMISSION_MODES as readonly unknown[]).includes(mode)) {
    return { code: "bypass_permission_mode", detail: `permissionMode ${String(mode)} bypasses permissions` };
  }
  if (raw.surface === "headless") {
    return { code: "headless_surface", detail: "a headless seat would run in default mode without the owner's grants" };
  }
  return undefined;
}

/**
 * Parses a `titan-seat/v1` file. `expectedName` is the name from the file name (`<name>.seat.json`),
 * which the definition's `name` must equal.
 */
export function parseSeat(text: string, expectedName: string): SeatResult<{ seat: SeatDefinition }> {
  const read = readJson(text);
  if (!read.ok) return read;
  const { raw } = read;
  if (raw.schema !== SEAT_SCHEMA) return refuse("unknown_schema", `schema ${String(raw.schema)}, expected ${SEAT_SCHEMA}`);
  const posture = postureRefusal(raw);
  if (posture !== undefined) return { ok: false, refusal: posture };
  const parsed = seatSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, refusal: refusalOf(raw, parsed.error.issues[0]!) };
  if (parsed.data.name !== expectedName) {
    return refuse("name_mismatch", `name ${parsed.data.name} in a file named for ${expectedName}`);
  }
  return { ok: true, seat: parsed.data };
}

/** Parses the owner-held seat index (`titan-seat-index/v1`) with the same strict rules. */
export function parseSeatIndex(text: string): SeatResult<{ index: SeatIndex }> {
  const read = readJson(text);
  if (!read.ok) return read;
  const { raw } = read;
  if (raw.schema !== SEAT_INDEX_SCHEMA) {
    return refuse("unknown_schema", `schema ${String(raw.schema)}, expected ${SEAT_INDEX_SCHEMA}`);
  }
  const parsed = seatIndexSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, refusal: refusalOf(raw, parsed.error.issues[0]!) };
  return { ok: true, index: parsed.data };
}
