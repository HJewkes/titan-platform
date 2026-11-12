/**
 * Every reason a seat definition is refused. The list is closed: a broker reports the code in
 * `seat_definition_unloadable: <code>` and never falls back to the requester's own launch.
 */
export const SEAT_REFUSAL_CODES = [
  "unreadable",
  "malformed_json",
  "not_an_object",
  "unknown_schema",
  "unknown_field",
  "missing_field",
  "invalid_field",
  "bypass_permission_mode",
  "headless_surface",
  "name_mismatch",
  "symlink",
  "not_regular_file",
  "wrong_owner",
  "writable_by_others",
  "outside_seats_dir",
  "agent_writable_path",
  "seats_dir_unsafe",
  "prompt_unreadable",
  "prompt_hash_mismatch",
  "owner_only_read_not_listed",
] as const;

export type SeatRefusalCode = (typeof SEAT_REFUSAL_CODES)[number];

/** `detail` names the field, path or value the code is about. */
export interface SeatRefusal {
  code: SeatRefusalCode;
  detail: string;
}

export type SeatResult<T> = ({ ok: true } & T) | { ok: false; refusal: SeatRefusal };

export const refuse = (code: SeatRefusalCode, detail: string): { ok: false; refusal: SeatRefusal } => ({
  ok: false,
  refusal: { code, detail },
});
