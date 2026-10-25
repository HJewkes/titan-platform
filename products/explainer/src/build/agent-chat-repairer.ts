import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { dataFence, dispatchToAgentChat, listAgents, retire, type AgentRow } from "@titan-design/agent-dispatch";
import type { LayerRepair, LayerRepairer, RepairRequest } from "./beat-worker.js";
import { LAYER_IMPORT_ALLOWLIST } from "./compile-gate.js";
import { SAFE_FILE_STEM } from "./layer-tree.js";
import { sessionSpend, UNKNOWN_SPEND } from "./session-spend.js";

/** The agent-chat profile a repair runs under; its TSX variant is TP-2608's. */
export const DEFAULT_REPAIR_PROFILE = "beat-builder";
const CLI_TIMEOUT_MS = 30_000;
const DEFAULT_REPAIR_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_POLL_MS = 5_000;

export interface AgentChatRepairerDeps {
  /** The absolute path of the `agent-chat` binary. */
  agentChatBin: string;
  profile?: string;
  /** Where agent-chat's installed profiles live; agent-chat's own default when absent. */
  profilesDir?: string;
  /** The Claude config dir the agent's transcript is under; `CLAUDE_CONFIG_DIR` or `~/.claude` when absent. */
  claudeConfigDir?: string;
  /** How long one repair may run, spawn to exit. */
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** The brief, sent on stdin: the packet, the failing module and the gate's error, each fenced as data. */
export function repairBrief({ packet, module, error }: RepairRequest, target: string): string {
  return [
    `Repair the custom layer for beat ${packet.packet.beat_id} of an explainer video. Its module failed the build gate.`,
    `Write the whole repaired module to ${target}, and change nothing else. Keep the packet's anchors and every cue target's element id.`,
    `Import only from: ${LAYER_IMPORT_ALLOWLIST.join(", ")}.`,
    dataFence("packet", packet.json.trimEnd()),
    dataFence("failing module", module.trimEnd()),
    dataFence("build error", error),
  ].join("\n\n");
}

const peerNameFor = (key: string) => `layer-repair-${key.slice(0, 16)}`;

async function waitForExit(deps: Required<Pick<AgentChatRepairerDeps, "agentChatBin" | "pollMs" | "sleep" | "now">>, name: string, deadline: number, signal?: AbortSignal): Promise<AgentRow> {
  for (;;) {
    signal?.throwIfAborted();
    const row = (await listAgents(deps.agentChatBin, CLI_TIMEOUT_MS)).find((agent) => agent.name === name);
    if (row?.presence === "exited") return row;
    if (deps.now().getTime() >= deadline) throw new Error(`repair agent ${name} had not exited after its time limit`);
    await deps.sleep(deps.pollMs);
  }
}

/**
 * One repair round through an agent-chat agent: the brief goes on stdin, never argv; the agent writes `<beat>.tsx`
 * into the scratch dir. Once it exits, its spend is priced from its transcript, found by the roster's session id.
 */
export function agentChatRepairer(deps: AgentChatRepairerDeps): LayerRepairer {
  const profile = deps.profile ?? DEFAULT_REPAIR_PROFILE;
  const now = deps.now ?? (() => new Date());
  const poll = { agentChatBin: deps.agentChatBin, pollMs: deps.pollMs ?? DEFAULT_POLL_MS, sleep: deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))), now };
  return {
    id: "agent-chat",
    async repair(request, { signal }): Promise<LayerRepair> {
      const beatId = request.packet.packet.beat_id;
      if (!SAFE_FILE_STEM.test(beatId)) throw new Error(`${JSON.stringify(beatId)} cannot name a module file`);
      const target = path.join(request.scratchDir, `${beatId}.tsx`);
      rmSync(request.scratchDir, { recursive: true, force: true });
      mkdirSync(request.scratchDir, { recursive: true });
      const peerName = peerNameFor(request.key);
      const deadline = now().getTime() + (deps.timeoutMs ?? DEFAULT_REPAIR_TIMEOUT_MS);
      await dispatchToAgentChat({ agentChatBinPath: deps.agentChatBin, peerName, profile, brief: repairBrief(request, target), cwd: request.scratchDir, ...(deps.profilesDir ? { profilesDir: deps.profilesDir } : {}) }, CLI_TIMEOUT_MS, [profile]);
      let row: AgentRow;
      try {
        row = await waitForExit(poll, peerName, deadline, signal);
      } catch (error) {
        // Spawned but not seen to exit: it may still be spending, so its cost is unknown, not zero.
        return { usage: UNKNOWN_SPEND, error: error instanceof Error ? error.message : String(error) };
      }
      const usage = await sessionSpend(row, { at: now(), ...(deps.claudeConfigDir ? { configDir: deps.claudeConfigDir } : {}) });
      // The name is freed for a later run's repair of the same packet; a refused retire costs nothing already spent.
      await retire(deps.agentChatBin, peerName, CLI_TIMEOUT_MS).catch(() => undefined);
      return { ...(existsSync(target) ? { module: readFileSync(target, "utf8") } : {}), usage, ...(row.sessionId ? { sessionId: row.sessionId } : {}) };
    },
  };
}

function executable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The first executable `agent-chat` on PATH; `AGENT_CHAT_BIN` wins. */
export function resolveAgentChatBin(env: NodeJS.ProcessEnv): string | undefined {
  if (env.AGENT_CHAT_BIN) return env.AGENT_CHAT_BIN;
  return (env.PATH ?? "").split(path.delimiter).map((dir) => path.join(dir, "agent-chat")).find((file) => path.isAbsolute(file) && executable(file));
}

/**
 * The host's repairer: the one it set, none when it set `null`, and the agent-chat repairer by default when an
 * `agent-chat` binary is on this host. With none, a build that fails the gate stays marked for repair.
 */
export function layerRepairerFor(configured: LayerRepairer | null | undefined, env: NodeJS.ProcessEnv = process.env): LayerRepairer | undefined {
  if (configured !== undefined) return configured ?? undefined;
  const agentChatBin = resolveAgentChatBin(env);
  return agentChatBin ? agentChatRepairer({ agentChatBin }) : undefined;
}
