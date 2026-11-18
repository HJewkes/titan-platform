import { refuse, type SeatResult } from "./refusal.js";
import type { SeatDefinition } from "./schema.js";

/** What a requester asked for. Every posture field is advisory: the seat's own value wins. */
export interface LaunchRequest {
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
export interface SeatLaunch {
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

export type ResolvedLaunch = SeatResult<{ launch: SeatLaunch; overridden: (keyof LaunchRequest)[] }>;

function launchOf(seat: SeatDefinition): SeatLaunch {
  return {
    seat: seat.name,
    seatVersion: seat.version,
    profile: seat.profile,
    configDir: seat.configDir,
    permissionMode: seat.permissionMode,
    surface: seat.surface,
    cwd: seat.cwd,
    depth: seat.root ? 0 : 1,
    remoteControl: seat.remoteControl ? seat.name : undefined,
    ceiling: [...seat.ceiling],
    allow: [...seat.allow],
    deny: [...seat.deny],
    prompt: { ...seat.prompt },
    ownerOnlyRead: seat.ownerOnlyRead === true,
  };
}

const POSTURE_FIELDS = ["profile", "configDir", "permissionMode", "surface", "cwd", "depth"] as const;

function overriddenFields(request: LaunchRequest, launch: SeatLaunch): (keyof LaunchRequest)[] {
  const differs: (keyof LaunchRequest)[] = POSTURE_FIELDS.filter(
    (field) => request[field] !== undefined && request[field] !== launch[field],
  );
  if (request.remoteControl !== undefined && request.remoteControl !== (launch.remoteControl !== undefined)) {
    differs.push("remoteControl");
  }
  return differs;
}

/**
 * Builds the launch for a seat from its definition alone. The requester's profile, config dir,
 * permission mode, surface, cwd, depth and Remote Control choice are ignored and listed in
 * `overridden` so the broker can log the drift it corrected. Pure: no I/O, clock or environment.
 */
export function resolveLaunch(seat: SeatDefinition, request: LaunchRequest): ResolvedLaunch {
  if (request.seat !== seat.name) {
    return refuse("name_mismatch", `the launch targets ${request.seat}, the definition is ${seat.name}`);
  }
  const launch = launchOf(seat);
  return { ok: true, launch, overridden: overriddenFields(request, launch) };
}
