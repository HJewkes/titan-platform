export interface AccountProfile {
  label: string;
  configDir: string;
}

export const DEFAULT_LABEL = "default";

// Claude Code's own `~/.claude` is the default account; a profile dir such as
// `~/.claude-profiles/agents` is named by its last segment.
export function accountLabel(configDir: string): string {
  const segments = configDir.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  if (last === undefined || last === ".claude") return DEFAULT_LABEL;
  const label = last.replace(/^\.+/, "");
  return label.length > 0 ? label : DEFAULT_LABEL;
}
