import { z } from 'zod';

declare const SEAT_SCHEMA = "titan-seat/v1";
declare const SEAT_INDEX_SCHEMA = "titan-seat-index/v1";
declare const seatSchema: z.ZodObject<{
    schema: z.ZodLiteral<"titan-seat/v1">;
    name: z.ZodString;
    version: z.ZodNumber;
    singleInstance: z.ZodLiteral<true>;
    profile: z.ZodString;
    configDir: z.ZodString;
    permissionMode: z.ZodEnum<{
        auto: "auto";
        default: "default";
        acceptEdits: "acceptEdits";
        plan: "plan";
    }>;
    surface: z.ZodEnum<{
        "tmux-window": "tmux-window";
        "iterm-pane": "iterm-pane";
        "iterm-tab": "iterm-tab";
        "iterm-window": "iterm-window";
    }>;
    remoteControl: z.ZodBoolean;
    cwd: z.ZodString;
    root: z.ZodBoolean;
    ceiling: z.ZodArray<z.ZodString>;
    prompt: z.ZodObject<{
        path: z.ZodString;
        sha256: z.ZodString;
    }, z.core.$strict>;
    wake: z.ZodObject<{
        owner: z.ZodBoolean;
        cron: z.ZodOptional<z.ZodString>;
        events: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strict>;
    may: z.ZodArray<z.ZodString>;
    mayNot: z.ZodArray<z.ZodString>;
    allow: z.ZodArray<z.ZodString>;
    deny: z.ZodArray<z.ZodString>;
    ownerOnlyRead: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
type SeatDefinition = z.infer<typeof seatSchema>;
declare const seatIndexSchema: z.ZodObject<{
    schema: z.ZodLiteral<"titan-seat-index/v1">;
    seats: z.ZodArray<z.ZodString>;
    ownerOnlyReaders: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
type SeatIndex = z.infer<typeof seatIndexSchema>;

/**
 * Every reason a seat definition is refused. The list is closed: a broker reports the code in
 * `seat_definition_unloadable: <code>` and never falls back to the requester's own launch.
 */
declare const SEAT_REFUSAL_CODES: readonly ["unreadable", "malformed_json", "not_an_object", "unknown_schema", "unknown_field", "missing_field", "invalid_field", "bypass_permission_mode", "headless_surface", "name_mismatch", "symlink", "not_regular_file", "wrong_owner", "writable_by_others", "outside_seats_dir", "agent_writable_path", "seats_dir_unsafe", "prompt_unreadable", "prompt_hash_mismatch", "owner_only_read_not_listed"];
type SeatRefusalCode = (typeof SEAT_REFUSAL_CODES)[number];
/** `detail` names the field, path or value the code is about. */
interface SeatRefusal {
    code: SeatRefusalCode;
    detail: string;
}
type SeatResult<T> = ({
    ok: true;
} & T) | {
    ok: false;
    refusal: SeatRefusal;
};

/**
 * Parses a `titan-seat/v1` file. `expectedName` is the name from the file name (`<name>.seat.json`),
 * which the definition's `name` must equal.
 */
declare function parseSeat(text: string, expectedName: string): SeatResult<{
    seat: SeatDefinition;
}>;
/** Parses the owner-held seat index (`titan-seat-index/v1`) with the same strict rules. */
declare function parseSeatIndex(text: string): SeatResult<{
    index: SeatIndex;
}>;

/** The `lstat` facts a check needs; a `fs.Stats` from `lstat` satisfies it. */
interface FileFacts {
    isSymbolicLink(): boolean;
    isFile(): boolean;
    isDirectory(): boolean;
    uid: number;
    mode: number;
}
/** Where owner-held files may live and who must own them, as the reader observed it. */
interface OwnerFileContext {
    ownerUid: number;
    /** Absolute, resolved path of the owner-held seats directory. */
    seatsDir: string;
    seatsDirFacts: FileFacts;
    /** Absolute roots an agent can write (worktrees, agent scratch); none may contain the seats directory. */
    agentWritableRoots: readonly string[];
}
/**
 * The seat-policy fail-closed rules for an owner-held file: a regular file, not a symlink, owned
 * by the owner, not group- or world-writable, directly inside a safe seats directory that no agent
 * root overlaps. `filePath` is the absolute path the reader opened.
 */
declare function checkOwnerFile(filePath: string, facts: FileFacts, ctx: OwnerFileContext): SeatRefusal | undefined;

/**
 * What a reader saw for one owner-held file: the absolute path it opened, the `lstat` facts and
 * the bytes, or the error that stopped it. Anything missing is a refusal, never "no seat".
 */
interface OwnerFileRead {
    path: string;
    facts?: FileFacts;
    content?: string | Uint8Array;
    error?: string;
}
interface LoadSeatInput {
    /** The seat name the launch targets. */
    name: string;
    seat: OwnerFileRead;
    index: OwnerFileRead;
    /** The prompt file named by the definition, read from beside it. */
    prompt: Pick<OwnerFileRead, "content" | "error">;
    context: OwnerFileContext;
}
declare const SEAT_FILE_SUFFIX = ".seat.json";
type LoadedSeat = SeatResult<{
    seat: SeatDefinition;
    seatHash: string;
}>;
/** Every check a launch path must pass before it may use a seat definition, in fail-closed order. */
declare function loadSeat(input: LoadSeatInput): LoadedSeat;

/** What a requester asked for. Every posture field is advisory: the seat's own value wins. */
interface LaunchRequest {
    seat: string;
    profile?: string;
    configDir?: string;
    permissionMode?: string;
    surface?: string;
    cwd?: string;
    depth?: number;
    remoteControl?: boolean;
}
/** The launch a broker must perform, built only from the definition. */
interface SeatLaunch {
    seat: string;
    seatVersion: number;
    profile: string;
    configDir: string;
    permissionMode: SeatDefinition["permissionMode"];
    surface: SeatDefinition["surface"];
    cwd: string;
    /** 0 for a root seat; 1 for any other, whoever asked, so a deep requester cannot lower its ceiling. */
    depth: 0 | 1;
    /** The `--remote-control <name>` value, or undefined for none. */
    remoteControl: string | undefined;
    ceiling: string[];
    allow: string[];
    deny: string[];
    prompt: SeatDefinition["prompt"];
    ownerOnlyRead: boolean;
}
type ResolvedLaunch = SeatResult<{
    launch: SeatLaunch;
    overridden: (keyof LaunchRequest)[];
}>;
/**
 * Builds the launch for a seat from its definition alone. The requester's profile, config dir,
 * permission mode, surface, cwd, depth and Remote Control choice are ignored and listed in
 * `overridden` so the broker can log the drift it corrected. Pure: no I/O, clock or environment.
 */
declare function resolveLaunch(seat: SeatDefinition, request: LaunchRequest): ResolvedLaunch;

export { type FileFacts, type LaunchRequest, type LoadSeatInput, type LoadedSeat, type OwnerFileContext, type OwnerFileRead, type ResolvedLaunch, SEAT_FILE_SUFFIX, SEAT_INDEX_SCHEMA, SEAT_SCHEMA, type SeatDefinition, type SeatIndex, type SeatLaunch, type SeatRefusal, type SeatRefusalCode, type SeatResult, checkOwnerFile, loadSeat, parseSeat, parseSeatIndex, resolveLaunch, seatSchema };
