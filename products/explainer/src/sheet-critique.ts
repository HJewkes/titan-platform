import { z } from "zod";

export const CRITIQUE_PASSES = ["first-glance", "hierarchy", "evidence", "polish"] as const;

const CRITIQUE_WEIGHTS = { design: 0.4, clarity: 0.3, idea: 0.2, content: 0.1 } as const;
const GLOW_OVERALL_CAP = 6.5;
const UNSUPPORTED_NUMBER_CONTENT_CAP = 4;
const TOP_FINDINGS = 3;

const Score = z.number().min(0).max(10);

// Only the first two tags cap a score; the rest name tells a still can show, so a rubric can ask for them.
const CAP_TAGS = [
  "glow-or-gradient",
  "unsupported-number",
  "eyebrow-label",
  "numbered-steps",
  "three-card-row",
  "dark-void-background",
  "sameness-run",
] as const;

type CapTag =(typeof CAP_TAGS)[number];

const TAG_ALIASES: Readonly<Record<string, CapTag>> = {
  ...Object.fromEntries(CAP_TAGS.map((tag) => [tag, tag])),
  glow: "glow-or-gradient",
  gradient: "glow-or-gradient",
  "glow-gradient": "glow-or-gradient",
  "glow-and-gradient": "glow-or-gradient",
  "unsupported-numbers": "unsupported-number",
  "unsupported-figure": "unsupported-number",
};

function slugTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function normaliseTag(raw: string): string {
  const slug = slugTag(raw);
  return TAG_ALIASES[slug] ?? slug;
}

const CritiqueFindingSchema = z.object({
  cell: z.object({ beat: z.string().min(1), t: z.number().nonnegative() }).optional(),
  problem: z.string().min(1),
  change: z.string().min(1),
  tags: z.array(z.string()).transform((tags) => tags.map(normaliseTag)),
  severity: z.number().min(1).max(5),
});

export const CritiqueReplySchema = z.object({
  pass: z.enum(CRITIQUE_PASSES),
  findings: z.array(CritiqueFindingSchema),
  scores: z.object({ design: Score, clarity: Score, idea: Score, content: Score }),
});

export type CritiqueReply = z.infer<typeof CritiqueReplySchema>;

export interface CritiqueResult {
  overall: number;
  scores: CritiqueReply["scores"];
  top: string[];
}

type Located = Finding & { cell: NonNullable<Finding["cell"]> };
type Finding = CritiqueReply["findings"][number];
type Scores = CritiqueReply["scores"];

const DIMENSIONS: readonly (keyof Scores)[] = ["design", "clarity", "idea", "content"];

function isLocated(f: Finding): f is Located {
  return f.cell !== undefined;
}

function meanScores(replies: readonly CritiqueReply[]): Scores {
  const mean = (d: keyof Scores): number => (replies.length === 0 ? 0 : replies.reduce((sum, r) => sum + r.scores[d], 0) / replies.length);
  return { design: mean("design"), clarity: mean("clarity"), idea: mean("idea"), content: mean("content") };
}

function formatFinding(f: Located): string {
  return `${f.cell.t}s · ${f.cell.beat} · ${f.problem} -> ${f.change}`;
}

export function critiqueScore(replies: readonly unknown[]): CritiqueResult {
  const parsed = replies.map((r) => CritiqueReplySchema.parse(r));
  const findings = parsed.flatMap((r) => r.findings).filter(isLocated);
  const tagged = (tag: string): boolean => findings.some((f) => f.tags.includes(tag));
  const scores = meanScores(parsed);
  if (tagged("unsupported-number")) scores.content = Math.min(scores.content, UNSUPPORTED_NUMBER_CONTENT_CAP);
  const weighted = DIMENSIONS.reduce((sum, d) => sum + scores[d] * CRITIQUE_WEIGHTS[d], 0);
  const overall = tagged("glow-or-gradient") ? Math.min(weighted, GLOW_OVERALL_CAP) : weighted;
  const top = [...findings].sort((a, b) => b.severity - a.severity).slice(0, TOP_FINDINGS).map(formatFinding);
  return { overall, scores, top };
}
