const AGENT_CHAT_PREFIX = "agent-chat/";

/** agent-chat names each spawned agent's branch `agent-chat/<name>`, so the name is the agent that pushes fixes. */
export function implementerFromBranch(branch: string): string | undefined {
  if (!branch.startsWith(AGENT_CHAT_PREFIX)) return undefined;
  const name = branch.slice(AGENT_CHAT_PREFIX.length);
  return name === "" || name.includes("/") ? undefined : name;
}

/** The first `<letters>-<digits>` pair in the branch's last segment, upper-cased: `tc-tp-2239` reads `TP-2239`. */
export function taskFromBranch(branch: string): string | undefined {
  const parts = (branch.split("/").at(-1) ?? "").split("-");
  for (let i = 0; i + 1 < parts.length; i += 1) {
    if (/^[a-z]+$/i.test(parts[i]!) && /^\d+$/.test(parts[i + 1]!)) return `${parts[i]!.toUpperCase()}-${parts[i + 1]}`;
  }
  return undefined;
}
