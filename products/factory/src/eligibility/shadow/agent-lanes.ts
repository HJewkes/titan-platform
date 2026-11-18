import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentAccess } from "@titan-design/pm";
import { createRpcClient, liveSource } from "@titan-design/rpc-client";
import { parse } from "yaml";
import { z } from "zod";

/*
 * The shadow tick's visibility read (TP-5868, PLAN A8). active-work's own verdict comes first. A daemon built before
 * `withheld_from_agents` sends no row with the field, which would refuse every lane, so only then the verdict is rebuilt
 * from the same files active-work reads, through pm's `agentAccess`. Any unread input withholds.
 */

/** The lane initiatives an agent may see, and whether the daemon or the initiative files said so. */
interface VisibleLanes {
  lanes: ReadonlySet<string>;
  read: "rpc" | "file";
}

export type AgentLanesRead = (initiatives: readonly string[]) => Promise<VisibleLanes>;

interface InventoryRow {
  slug: string;
  withheld_from_agents?: boolean;
}

type InventoryRead = {
  inventory: { args: Record<string, never>; result: { initiatives: InventoryRow[] } };
};

const CharterSchema = z.object({ human_only_initiatives: z.array(z.string().min(1)) });

/** Null when the file is missing, has no front matter or its YAML does not parse: each reads as withheld. */
async function frontmatterOf(file: string): Promise<unknown> {
  try {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(await readFile(file, "utf8"));
    return match ? (parse(match[1]!) as unknown) : null;
  } catch {
    return null;
  }
}

async function humanOnlyList(activeRoot: string): Promise<ReadonlySet<string> | "unknown"> {
  const parsed = CharterSchema.safeParse(await frontmatterOf(join(activeRoot, "claude-channels", "sources", "autonomy", "charter.md")));
  return parsed.success ? new Set(parsed.data.human_only_initiatives) : "unknown";
}

/** The brief and the charter both have to allow agents, as in active-work's own `wireVisibility`. */
async function fileVisibleLanes(activeRoot: string, initiatives: readonly string[]): Promise<ReadonlySet<string>> {
  const humanOnly = await humanOnlyList(activeRoot);
  const shown = await Promise.all(
    initiatives.map(async (slug) => {
      const brief = await frontmatterOf(join(activeRoot, slug, "brief.md"));
      const listed = humanOnly === "unknown" ? "unknown" : humanOnly.has(slug);
      return agentAccess({ slug, brief, humanOnly: listed }) === "shown" ? [slug] : [];
    }),
  );
  return new Set(shown.flat());
}

const olderDaemon = (rows: readonly InventoryRow[]): boolean => rows.length > 0 && rows.every((row) => !("withheld_from_agents" in row));

/** A fallback lane must also be one the daemon lists, so the file read can only narrow what the daemon serves. */
export function shadowAgentLanes(origin: string, activeRoot: string, fetchImpl?: typeof fetch): AgentLanesRead {
  const client = createRpcClient<InventoryRead>(liveSource({ origin, ...(fetchImpl && { fetch: fetchImpl }) }));
  return async (initiatives) => {
    const { initiatives: rows } = await client.call("inventory", {});
    if (olderDaemon(rows)) {
      const listed = new Set(rows.map((row) => row.slug));
      const visible = await fileVisibleLanes(activeRoot, initiatives.filter((slug) => listed.has(slug)));
      return { lanes: visible, read: "file" };
    }
    return { lanes: new Set(rows.filter((row) => row.withheld_from_agents === false).map((row) => row.slug)), read: "rpc" };
  };
}
