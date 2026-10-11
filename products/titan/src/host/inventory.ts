import { join } from "node:path";
import type { HostDoctorRow } from "./doctor.js";
import type { HostPorts } from "./ports.js";

/** The centralization design's section 2 key: code, per-owner config, secret, per-host delta. */
type InventoryCategory = "a" | "b" | "c" | "d";
type InventoryPlatform = "darwin" | "linux" | "both";

export interface InventoryEntry {
  /** `~`-relative; a whole `*` segment expands to every directory under its parent. */
  path: string;
  categories: InventoryCategory[];
  platform: InventoryPlatform;
  /** Present on some hosts or roles only, so absence is a warning, not a failure. */
  optional?: boolean;
}

const both = "both" as const;
const darwin = "darwin" as const;
const linux = "linux" as const;

/**
 * One entry per path in the design's section 2. Runtime state (s) rows are left out: each host
 * recreates them. So are the leak-guard term list (any command naming its path is denied), the
 * active-work and autonomy roots (each product's own doctor resolves its configured root) and
 * the network rows, which are not paths.
 */
export const INVENTORY: InventoryEntry[] = [
  { path: "~/.claude/settings.json", categories: ["b", "d"], platform: both },
  { path: "~/.claude/settings.local.json", categories: ["b"], platform: both, optional: true },
  { path: "~/.claude/.claude.json", categories: ["b", "d"], platform: both },
  { path: "~/.claude/.mcp.json", categories: ["c"], platform: both, optional: true },
  { path: "~/.claude/hooks/git-safety/git-safety.mjs", categories: ["a"], platform: both },
  { path: "~/.claude/scripts", categories: ["a", "d"], platform: both },
  { path: "~/.claude/statusline-command.sh", categories: ["a"], platform: both },
  { path: "~/.claude/skills", categories: ["a"], platform: both },
  { path: "~/.claude/plugins", categories: ["a", "d"], platform: both },
  { path: "~/.claude/commands", categories: ["b"], platform: both, optional: true },
  { path: "~/.claude/output-styles", categories: ["b"], platform: both, optional: true },
  { path: "~/.claude/agents", categories: ["b"], platform: both, optional: true },
  { path: "~/.claude-profiles/*/settings.json", categories: ["b"], platform: both },
  { path: "~/.claude-profiles/*/.credentials.json", categories: ["c"], platform: linux },
  { path: "~/.agent-chat/config.json", categories: ["b", "d"], platform: both },
  { path: "~/.agent-chat/profiles", categories: ["b"], platform: both },
  { path: "~/.agent-chat/hooks.json", categories: ["b", "d"], platform: both, optional: true },
  { path: "~/.agent-chat/hooks/notify-hermes.sh", categories: ["b", "d"], platform: darwin, optional: true },
  { path: "~/.agent-chat/burndown.config.json", categories: ["b"], platform: both, optional: true },
  { path: "~/.agent-chat/seat-watchdog.json", categories: ["b"], platform: both, optional: true },
  { path: "~/.agent-chat/factory-host", categories: ["d"], platform: both, optional: true },
  { path: "~/.agent-chat/ui.token", categories: ["c"], platform: both },
  { path: "~/.agent-chat/mirror.env", categories: ["c"], platform: both, optional: true },
  { path: "~/.config/titan-factory/config.json", categories: ["b", "d"], platform: both },
  { path: "~/.config/gh/hosts.yml", categories: ["c"], platform: both },
  { path: "~/.config/gh/config.yml", categories: ["b"], platform: both },
  { path: "~/.config/git", categories: ["b"], platform: both, optional: true },
  { path: "~/.gitconfig", categories: ["b"], platform: both },
  { path: "~/.config/chezmoi/key.txt", categories: ["c"], platform: both },
  { path: "~/.config/chezmoi/claude-settings-patch.json", categories: ["b"], platform: both, optional: true },
  { path: "~/.local/private/chezmoi", categories: ["b", "c"], platform: both },
  { path: "~/.local/share/chezmoi", categories: ["a"], platform: both },
  { path: "~/.local/share/chezmoi/encrypted_private_dot_secrets.zsh.age", categories: ["c"], platform: both },
  ...["active-work", "agent", "agent-chat", "titan-factory", "seat-merge", "claude", "clean-gone-branches"].map(
    (bin): InventoryEntry => ({ path: `~/.local/bin/${bin}`, categories: ["a"], platform: both }),
  ),
  ...["aw-backup.sh", "shepherd-health-sampler.sh", "mem-sampler.sh", "tp-ram-machine-watch.sh"].map(
    (script): InventoryEntry => ({ path: `~/.local/libexec/${script}`, categories: ["a"], platform: darwin }),
  ),
  { path: "~/.local/libexec/claude-shim/claude", categories: ["a"], platform: both },
  ...["active-work", "titan-factory", "agent-chat-seat-watchdog", "agent-chat-burndown"].map(
    (job): InventoryEntry => ({ path: `~/Library/LaunchAgents/dev.hjewkes.${job}.plist`, categories: ["d"], platform: darwin }),
  ),
  ...["aw-backup", "shepherd-health-sampler", "mem-sampler"].map(
    (job): InventoryEntry => ({ path: `~/Library/LaunchAgents/dev.hjewkes.${job}.plist`, categories: ["d"], platform: darwin, optional: true }),
  ),
  { path: "~/Library/LaunchAgents/com.claude.usage-refresh.plist", categories: ["d"], platform: darwin, optional: true },
  ...["titan-platform", "agent-chat", "active-work"].map(
    (repo): InventoryEntry => ({ path: `~/projects/${repo}`, categories: ["a"], platform: both }),
  ),
  { path: "~/projects/audiobook/.env", categories: ["c", "d"], platform: both, optional: true },
  { path: "~/projects/audiobook/.mcp.json", categories: ["c", "d"], platform: both, optional: true },
];

/** One presence row per inventory path on this platform. Every check is a stat; nothing is opened. */
export async function inventoryRows(
  ports: HostPorts,
  home: string,
  platform: NodeJS.Platform,
  entries: InventoryEntry[] = INVENTORY,
): Promise<HostDoctorRow[]> {
  const onPlatform = entries.filter((entry) => entry.platform === "both" || entry.platform === platform);
  const rows = await Promise.all(onPlatform.map((entry) => entryRows(entry, ports, home)));
  return rows.flat();
}

async function entryRows(entry: InventoryEntry, ports: HostPorts, home: string): Promise<HostDoctorRow[]> {
  const paths = await expand(entry.path, ports, home);
  if (paths.length === 0) return [absentRow(entry, entry.path)];
  return Promise.all(paths.map((path) => presenceRow(entry, path, ports, home)));
}

async function presenceRow(entry: InventoryEntry, path: string, ports: HostPorts, home: string): Promise<HostDoctorRow> {
  const kind = await ports.stat(absolute(path, home));
  if (!kind) return absentRow(entry, path);
  return { id: `inventory:${path}`, group: "inventory", status: "ok", detail: `present ${kind} (${label(entry)})` };
}

function absentRow(entry: InventoryEntry, path: string): HostDoctorRow {
  const status = entry.optional ? "warn" : "missing";
  return { id: `inventory:${path}`, group: "inventory", status, detail: `absent (${label(entry)})` };
}

function label(entry: InventoryEntry): string {
  return entry.categories.join(", ");
}

/** Expands a whole `*` segment to the directories under its parent; other paths pass through. */
async function expand(path: string, ports: HostPorts, home: string): Promise<string[]> {
  const star = path.indexOf("/*/");
  if (star === -1) return [path];
  const parent = path.slice(0, star);
  const rest = path.slice(star + 3);
  const names = await ports.list(absolute(parent, home));
  const dirs = await Promise.all(names.map(async (name) => ((await ports.stat(absolute(`${parent}/${name}`, home))) === "dir" ? name : null)));
  return dirs.filter((name): name is string => name !== null).sort().map((name) => `${parent}/${name}/${rest}`);
}

function absolute(path: string, home: string): string {
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}
