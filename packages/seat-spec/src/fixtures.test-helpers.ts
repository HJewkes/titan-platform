import { createHash } from "node:crypto";
import type { FileFacts, OwnerFileContext } from "./file-checks.js";
import type { LoadSeatInput } from "./load.js";

export const HOME = "/home/example";
export const SEATS_DIR = `${HOME}/.agent-chat/seats`;
const OWNER_UID = 1000;
const PROMPT_TEXT = "# example-steward\n\nWork the weekly review.\n";
const PROMPT_SHA = createHash("sha256").update(PROMPT_TEXT).digest("hex");

/** A steward in the shape of the plan's 2.4 sketch. */
export const stewardSeat = (): Record<string, unknown> => ({
  schema: "titan-seat/v1",
  name: "example-steward",
  version: 1,
  singleInstance: true,
  profile: "example-coordinator",
  configDir: `${HOME}/.claude-profiles/example-server`,
  permissionMode: "auto",
  surface: "tmux-window",
  remoteControl: true,
  cwd: `${HOME}/projects/example`,
  root: true,
  ceiling: ["example-planner", "example-researcher"],
  prompt: { path: "example-steward.prompt.md", sha256: PROMPT_SHA },
  wake: { owner: true, cron: "0 9 * * 1", events: ["incident"] },
  may: ["dispatch planners and researchers"],
  mayNot: ["dispatch implementers"],
  allow: [],
  deny: ["Bash(git push*)"],
});

/** The personal desk from the plan's 3.1 sketch, with the 3.5 deny list. */
export const deskSeat = (): Record<string, unknown> => ({
  schema: "titan-seat/v1",
  name: "example-desk",
  version: 1,
  singleInstance: true,
  profile: "example-desk",
  configDir: `${HOME}/.claude-profiles/example-personal`,
  permissionMode: "auto",
  surface: "tmux-window",
  remoteControl: true,
  cwd: `${HOME}/projects/example-desk`,
  root: false,
  ceiling: [],
  prompt: { path: "example-desk.prompt.md", sha256: PROMPT_SHA },
  wake: { owner: true, cron: "0 7,12,17 * * *" },
  may: ["set due dates", "close a task only when an owner answer names it"],
  mayNot: ["send mail", "spawn agents"],
  allow: [],
  deny: ["mcp__*gmail*", "mcp__plugin_agent-chat_agent-chat__agent_*", "Bash(git *)", "WebFetch"],
  ownerOnlyRead: true,
});

export const json = (value: unknown): string => JSON.stringify(value, null, 2);

export const facts = (over: Partial<{ kind: "file" | "dir" | "symlink"; uid: number; mode: number }> = {}): FileFacts => {
  const kind = over.kind ?? "file";
  return {
    isSymbolicLink: () => kind === "symlink",
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    uid: over.uid ?? OWNER_UID,
    mode: over.mode ?? 0o100644,
  };
};

export const context = (over: Partial<OwnerFileContext> = {}): OwnerFileContext => ({
  ownerUid: OWNER_UID,
  seatsDir: SEATS_DIR,
  seatsDirFacts: facts({ kind: "dir", mode: 0o40755 }),
  agentWritableRoots: [`${HOME}/projects/example/.worktrees`, "/tmp/agent-scratch"],
  ...over,
});

const LISTED_SEATS = ["example-steward", "example-desk", "example-second-desk"];

export const indexJson = (ownerOnlyReaders: string[] = [], seats: string[] = LISTED_SEATS): string =>
  json({ schema: "titan-seat-index/v1", seats, ownerOnlyReaders });

/** A load input for `seat` whose every file passes the checks. */
export const loadInput = (seat: Record<string, unknown>, over: Partial<LoadSeatInput> = {}): LoadSeatInput => {
  const name = String(seat.name);
  return {
    name,
    seat: { path: `${SEATS_DIR}/${name}.seat.json`, facts: facts(), content: json(seat) },
    index: { path: `${SEATS_DIR}/index.json`, facts: facts(), content: indexJson() },
    prompt: { content: PROMPT_TEXT },
    context: context(),
    ...over,
  };
};
