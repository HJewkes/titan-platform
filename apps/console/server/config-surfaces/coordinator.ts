import { readdir } from "node:fs/promises";
import path from "node:path";
import { expandHome } from "@titan-design/session-read";
import { joinSurfaces, type SurfaceReader } from "./catalog.js";
import { BURNDOWN_SURFACE, CHARTER_SURFACE, SEAT_SURFACE, SEAT_WATCHDOG_SURFACE } from "./specs.js";
import { readTarget, type Target } from "./files.js";

export interface CoordinatorRoots {
  /** Holds `charter.md` and `seats/*.md`; null until `TITAN_CONSOLE_AUTONOMY_DIR` names it, since it has no fixed home. */
  autonomyDir: string | null;
  /** Holds `burndown.config.json` and `seat-watchdog.json`. */
  agentChatDir: string;
}

export const AUTONOMY_DIR_UNSET = "autonomy tree: TITAN_CONSOLE_AUTONOMY_DIR is not set";

export function coordinatorRootsFrom(env: NodeJS.ProcessEnv, home: string): CoordinatorRoots {
  const autonomy = env.TITAN_CONSOLE_AUTONOMY_DIR;
  return {
    autonomyDir: autonomy ? expandHome(autonomy, home) : null,
    agentChatDir: expandHome(env.AGENT_CHAT_HOME ?? "~/.agent-chat", home),
  };
}

/** A README or a dotfile beside the seats documents them; read as a seat it would show as one with no front matter. */
const isSeatFile = (name: string): boolean => name.endsWith(".md") && !name.startsWith(".") && name.toLowerCase() !== "readme.md";

async function autonomyTargets(autonomyDir: string): Promise<{ targets: Target[]; gaps: string[] }> {
  const charter: Target = { spec: CHARTER_SURFACE, surface: "charter", file: path.join(autonomyDir, "charter.md") };
  const seatsDir = path.join(autonomyDir, "seats");
  const names = await readdir(seatsDir).catch(() => null);
  if (names === null) return { targets: [charter], gaps: [`${seatsDir}: not readable`] };
  const seats = names
    .filter(isSeatFile)
    .sort()
    .map((name) => ({ spec: SEAT_SURFACE, surface: `seat:${path.basename(name, ".md")}`, file: path.join(seatsDir, name) }));
  return { targets: [charter, ...seats], gaps: [] };
}

/** The charter and seat front matter, the burndown roster and the watchdog's owner switches on this host. */
export function coordinatorSurfaces(roots: CoordinatorRoots): SurfaceReader {
  return async () => {
    const autonomy = roots.autonomyDir === null ? { targets: [], gaps: [AUTONOMY_DIR_UNSET] } : await autonomyTargets(roots.autonomyDir);
    const targets = [
      ...autonomy.targets,
      { spec: BURNDOWN_SURFACE, surface: "burndown", file: path.join(roots.agentChatDir, "burndown.config.json") },
      { spec: SEAT_WATCHDOG_SURFACE, surface: "seat-watchdog", file: path.join(roots.agentChatDir, "seat-watchdog.json") },
    ];
    const answer = joinSurfaces(await Promise.all(targets.map((target) => readTarget(target))));
    return { ...answer, gaps: [...autonomy.gaps, ...answer.gaps] };
  };
}
