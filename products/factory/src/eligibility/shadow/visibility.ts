import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentAccess, type AgentAccess } from "@titan-design/pm";
import { parse } from "yaml";
import { z } from "zod";

/*
 * Whether agents may read a lane's initiative (TP-5755 PLAN 5.4, amendment A7), judged by pm's `agentAccess` over the
 * same two files active-work's own visibility module reads: the initiative's brief and the autonomy charter. Every
 * unreadable input withholds, so a lane is never judged visible by accident.
 */

export type LaneAccessRead = (initiative: string) => Promise<AgentAccess>;

const CharterSchema = z.object({ human_only_initiatives: z.array(z.string().min(1)) });

async function frontMatter(file: string): Promise<unknown> {
  try {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(await readFile(file, "utf8"));
    return match === null ? null : (parse(match[1]!) as unknown);
  } catch {
    return null;
  }
}

async function humanOnly(activeRoot: string, initiative: string): Promise<boolean | "unknown"> {
  const charter = CharterSchema.safeParse(await frontMatter(join(activeRoot, "claude-channels", "sources", "autonomy", "charter.md")));
  return charter.success ? charter.data.human_only_initiatives.includes(initiative) : "unknown";
}

/** Reads the two files under the active-work root; reads only. */
export function liveLaneAccess(activeRoot: string): LaneAccessRead {
  return async (initiative) => {
    const [brief, listed] = await Promise.all([frontMatter(join(activeRoot, initiative, "brief.md")), humanOnly(activeRoot, initiative)]);
    return agentAccess({ slug: initiative, brief, humanOnly: listed });
  };
}
