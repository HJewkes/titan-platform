import { z } from "zod";

export const SEAT_SCHEMA = "titan-seat/v1";
export const SEAT_INDEX_SCHEMA = "titan-seat-index/v1";

/** The modes agent-chat's teleport allowlist carries. Bypass modes are refused by name in parse. */
export const SEAT_PERMISSION_MODES = ["auto", "default", "acceptEdits", "plan"] as const;
export const BYPASS_PERMISSION_MODES = ["bypassPermissions", "dontAsk"] as const;

/** Interactive surfaces only: a headless launch pins `--permission-mode default` and drops the owner's grants. */
export const SEAT_SURFACES = ["tmux-window", "iterm-pane", "iterm-tab", "iterm-window"] as const;

const SEAT_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const PROMPT_FILE = /^[a-z0-9][a-z0-9._-]*\.md$/;
const CRON_FIELDS = 5;

const seatName = z.string().regex(SEAT_NAME);
const nameList = z.array(z.string().min(1));
const DEL = 0x7f;
const hasControlChar = (value: string): boolean =>
  [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === DEL);
const absolutePath = z
  .string()
  .refine(
    (value) => value.startsWith("/") && !value.split("/").includes("..") && !hasControlChar(value),
    "must be an absolute path with no .. and no control characters",
  );
const cron = z.string().refine((value) => value.trim().split(/\s+/).length === CRON_FIELDS, "must be a 5-field cron");

const promptSchema = z.strictObject({
  path: z.string().regex(PROMPT_FILE, "must be a bare .md file name beside the seat file"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters"),
});

const wakeSchema = z.strictObject({
  owner: z.boolean(),
  cron: cron.optional(),
  events: nameList.optional(),
});

export const seatSchema = z.strictObject({
  schema: z.literal(SEAT_SCHEMA),
  name: seatName,
  version: z.number().int().positive(),
  singleInstance: z.literal(true),
  profile: z.string().min(1),
  configDir: absolutePath,
  permissionMode: z.enum(SEAT_PERMISSION_MODES),
  surface: z.enum(SEAT_SURFACES),
  remoteControl: z.boolean(),
  cwd: absolutePath,
  root: z.boolean(),
  ceiling: nameList,
  prompt: promptSchema,
  wake: wakeSchema,
  may: nameList,
  mayNot: nameList,
  allow: nameList,
  deny: nameList,
  ownerOnlyRead: z.boolean().optional(),
});

export type SeatDefinition = z.infer<typeof seatSchema>;

export const seatIndexSchema = z
  .strictObject({
    schema: z.literal(SEAT_INDEX_SCHEMA),
    seats: z.array(seatName),
    ownerOnlyReaders: z.array(seatName).max(1, "at most one seat may read owner-only data"),
  })
  .refine((index) => index.ownerOnlyReaders.every((reader) => index.seats.includes(reader)), {
    message: "every owner-only reader must be a listed seat",
    path: ["ownerOnlyReaders"],
  });

export type SeatIndex = z.infer<typeof seatIndexSchema>;
