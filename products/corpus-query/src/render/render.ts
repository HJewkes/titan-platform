import type { MergedRow } from "../merge/merge.js";

/** Discord rejects 2000 and over; the margin absorbs any counting difference. */
export const DISCORD_LIMIT = 1900;

export interface DiscordOptions {
  header: string;
  limit?: number;
}

/** A `||` inside a field would end the spoiler early. */
function defuse(text: string): string {
  return text.replace(/\|\|+/g, "|").replace(/\s*\n\s*/g, " ").trim();
}

function rowLine(r: MergedRow): string {
  const parts = [`**${defuse(r.entity)}**`, defuse(r.detail), defuse(r.ref)].filter((p) => p.length > 0);
  return `• ||${parts.join(" · ")}||`;
}

const seasonOf = (r: MergedRow) => r.period || "Undated";

/** Splits only between rows. A continuation repeats its season heading so it reads on its own. */
export function renderDiscord(rows: MergedRow[], options: DiscordOptions): string[] {
  const limit = options.limit ?? DISCORD_LIMIT;
  const messages: string[] = [];
  let buffer: string[] = [options.header];
  let season: string | undefined;
  for (const r of rows) {
    const heading = `**${defuse(seasonOf(r))}**`;
    const line = rowLine(r);
    const addition = seasonOf(r) === season ? [line] : [heading, line];
    if ([...buffer, ...addition].join("\n").length < limit) {
      buffer.push(...addition);
    } else if ([heading, line].join("\n").length >= limit) {
      throw new RangeError(`one row exceeds the ${limit}-character message limit`);
    } else {
      messages.push(buffer.join("\n"));
      buffer = [heading, line];
    }
    season = seasonOf(r);
  }
  messages.push(buffer.join("\n"));
  return messages;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

export function renderMarkdown(rows: MergedRow[]): string {
  const head = ["| # | Entity | Period | Subject | Role | Ref | Evidence |", "|---|---|---|---|---|---|---|"];
  const body = rows.map((r, i) => {
    const period = cell(r.period) + (r.periodInferred ? " (inferred)" : "");
    const subject = [cell(r.subject), cell(r.detail)].filter((p) => p).join(" — ");
    return `| ${i + 1} | ${cell(r.entity)} | ${period} | ${subject} | ${cell(r.role)} | ${cell(r.ref)} | ${cell(r.quote)} |`;
  });
  return [...head, ...body].join("\n") + "\n";
}
