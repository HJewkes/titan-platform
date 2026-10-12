import { visibleLines } from "@titan-design/session-read";
import { z } from "zod";

export const FOLLOW_UPS_HEADING = "Follow-ups:";
const FOLLOW_UPS_NONE = "Follow-ups: none";
export const MAX_FOLLOW_UPS = 5;
export const MAX_FOLLOW_UP_TITLE_CHARS = 120;
export const MAX_FOLLOW_UP_DONE_WHEN_CHARS = 400;
/** No `critical`: anything that serious belongs in a FIX_FIRST, not in work deferred past the merge. */
export const FOLLOW_UP_SEVERITIES = ["low", "medium", "high"] as const;

/** One task a reviewer proposes for later; it never decides the verdict. */
export const FollowUpSchema = z.strictObject({
  title: z.string().min(1).max(MAX_FOLLOW_UP_TITLE_CHARS),
  doneWhen: z.string().min(1).max(MAX_FOLLOW_UP_DONE_WHEN_CHARS),
  severity: z.enum(FOLLOW_UP_SEVERITIES),
});

export type FollowUp = z.infer<typeof FollowUpSchema>;

export const FOLLOW_UPS_WARNINGS = ["multiple_blocks", "bad_item", "bad_severity", "too_many", "too_long", "placeholder"] as const;

/** Why a Follow-ups block was dropped whole; a closed set, so no reviewer text travels with it. */
export type FollowUpsWarning = (typeof FOLLOW_UPS_WARNINGS)[number];

export interface ParsedFollowUps {
  items: FollowUp[];
  warning?: FollowUpsWarning;
}

const PLACEHOLDER = /^<.*>$/;

function parseItem(line: string): FollowUp | FollowUpsWarning {
  const fields = line.slice(2).split(" | ").map((field) => field.trim());
  if (fields.length !== 3 || fields.some((field) => field === "")) return "bad_item";
  if (fields.some((field) => PLACEHOLDER.test(field))) return "placeholder";
  const [title, doneWhen, severity] = fields;
  const parsed = FollowUpSchema.safeParse({ title, doneWhen, severity: severity?.toLowerCase() });
  if (parsed.success) return parsed.data;
  return parsed.error.issues.some((issue) => issue.path[0] === "severity") ? "bad_severity" : "too_long";
}

/** The `- ` lines directly under the heading, up to the first line that is blank, hidden or not a bullet. */
function bulletsAfter(lines: readonly (string | null)[], heading: number): string[] {
  const bullets: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (line == null || !line.startsWith("- ")) break;
    bullets.push(line);
  }
  return bullets;
}

/**
 * The one `Follow-ups:` block anywhere in a reviewer's visible text, before or after the verdict lines. Any fault drops the
 * whole block with one named warning rather than filing part of it, and nothing here can change the verdict.
 */
export function parseFollowUps(text: string): ParsedFollowUps {
  const lines = visibleLines(text);
  const headings = lines.flatMap((line, index) => (line?.startsWith(FOLLOW_UPS_HEADING) ? [index] : []));
  if (headings.length === 0) return { items: [] };
  if (headings.length > 1) return { items: [], warning: "multiple_blocks" };
  const heading = lines[headings[0]!];
  if (heading === FOLLOW_UPS_NONE) return { items: [] };
  const bullets = heading === FOLLOW_UPS_HEADING ? bulletsAfter(lines, headings[0]!) : [];
  if (bullets.length === 0) return { items: [], warning: "bad_item" };
  if (bullets.length > MAX_FOLLOW_UPS) return { items: [], warning: "too_many" };
  const items: FollowUp[] = [];
  for (const parsed of bullets.map(parseItem)) {
    if (typeof parsed === "string") return { items: [], warning: parsed };
    items.push(parsed);
  }
  return { items };
}

/** The fields an accepted verdict carries: both absent when the reviewer proposed nothing and wrote nothing malformed. */
export function followUpsFields(text: string): { followUps?: FollowUp[]; followUpsWarning?: FollowUpsWarning } {
  const { items, warning } = parseFollowUps(text);
  return { ...(items.length > 0 && { followUps: items }), ...(warning && { followUpsWarning: warning }) };
}
