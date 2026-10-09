import type { AccountProfile } from "../profile.js";
import type { FetchLike } from "../node/poll.js";
import { discoverProfiles } from "../node/profiles.js";

export interface CliContext {
  env: Readonly<Record<string, string | undefined>>;
  // Defaults to os.homedir(); tests pass a temp dir.
  home?: string;
  // Defaults to globalThis.fetch. It receives the raw tokens, so tests pass a fake.
  fetch?: FetchLike;
  now: () => number;
  // The uid that must own each credentials file. Defaults to this process's.
  uid?: number;
  out: (line: string) => void;
  err: (line: string) => void;
}

export function profilesOf(context: CliContext): AccountProfile[] {
  return discoverProfiles({ home: context.home, env: context.env });
}

export function fetchOf(context: CliContext): FetchLike {
  return context.fetch ?? globalThis.fetch;
}
