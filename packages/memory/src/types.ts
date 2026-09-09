import { z } from "zod";

/**
 * The playbook data model, borrowed from cass-memory's `PlaybookBullet`. Counts
 * are never stored: they are derived from the append-only feedback log at read
 * time, so decay parameters can change without re-running reflection.
 */
export const BULLET_SCOPES = ["global", "workspace", "language", "framework", "task"] as const;
export const BULLET_TYPES = ["rule", "anti-pattern"] as const;
export const BULLET_KINDS = ["project_convention", "stack_pattern", "workflow_rule", "anti_pattern"] as const;
export const BULLET_SOURCES = ["learned", "community", "manual", "custom"] as const;
export const BULLET_STATES = ["draft", "active", "retired"] as const;
export const MATURITIES = ["candidate", "established", "proven", "deprecated"] as const;

export type BulletScope = (typeof BULLET_SCOPES)[number];
export type BulletType = (typeof BULLET_TYPES)[number];
export type BulletKind = (typeof BULLET_KINDS)[number];
export type BulletSource = (typeof BULLET_SOURCES)[number];
export type BulletState = (typeof BULLET_STATES)[number];
export type Maturity = (typeof MATURITIES)[number];
export type FeedbackType = "helpful" | "harmful";

/** Where a bullet's evidence lives: a session ref plus a byte offset into its transcript. */
export interface Provenance {
  sessionRef: string;
  byteOffset?: number;
}

export interface Bullet {
  id: string;
  content: string;
  category: string;
  tags: string[];
  scope: BulletScope;
  type: BulletType;
  kind: BulletKind;
  isNegative: boolean;
  source: BulletSource;
  state: BulletState;
  maturity: Maturity;
  pinned: boolean;
  pinnedReason: string | null;
  /** Set when retired in favour of another bullet; mirrored by a `supersedes` edge. */
  replacedBy: string | null;
  deprecatedAt: string | null;
  deprecationReason: string | null;
  halfLifeDays: number;
  sourceSessions: Provenance[];
  reasoning: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewBullet {
  id?: string;
  content: string;
  category?: string;
  tags?: string[];
  scope?: BulletScope;
  type?: BulletType;
  kind?: BulletKind;
  isNegative?: boolean;
  source?: BulletSource;
  state?: BulletState;
  pinned?: boolean;
  pinnedReason?: string | null;
  halfLifeDays?: number;
  sourceSessions?: Provenance[];
  reasoning?: string | null;
}

/** One line of the immutable feedback log. */
export interface FeedbackEvent {
  id: number;
  bulletId: string;
  type: FeedbackType;
  at: string;
  sessionRef: string | null;
  reason: string | null;
}

export interface DecayedCounts {
  helpful: number;
  harmful: number;
}

export interface ScoredBullet extends Bullet {
  helpfulCount: number;
  harmfulCount: number;
  decayedHelpful: number;
  decayedHarmful: number;
  effectiveScore: number;
  /** Latest feedback, or creation when there is none; the input to staleness. */
  lastEvidenceAt: string;
}

/**
 * What a reflector proposes. Provenance is deliberately absent: the curator
 * stamps it from the session it is actually processing, never from the model.
 */
const addDelta = z.object({
  type: z.literal("add"),
  content: z.string().min(1),
  category: z.string().min(1).default("general"),
  tags: z.array(z.string()).default([]),
  scope: z.enum(BULLET_SCOPES).default("workspace"),
  kind: z.enum(BULLET_KINDS).default("workflow_rule"),
  isNegative: z.boolean().default(false),
  reasoning: z.string().optional(),
});
const feedbackDelta = (type: FeedbackType) => z.object({ type: z.literal(type), bulletId: z.string().min(1), reason: z.string().optional() });
const replaceDelta = z.object({ type: z.literal("replace"), bulletId: z.string().min(1), content: z.string().min(1), reasoning: z.string().optional() });
const deprecateDelta = z.object({ type: z.literal("deprecate"), bulletId: z.string().min(1), reason: z.string().min(1) });
const mergeDelta = z.object({ type: z.literal("merge"), bulletIds: z.array(z.string().min(1)).min(2), content: z.string().min(1), reasoning: z.string().optional() });

export const PlaybookDeltaSchema = z.discriminatedUnion("type", [
  addDelta,
  feedbackDelta("helpful"),
  feedbackDelta("harmful"),
  replaceDelta,
  deprecateDelta,
  mergeDelta,
]);
/** What callers and reflectors write; defaults may be omitted. */
export type PlaybookDelta = z.input<typeof PlaybookDeltaSchema>;
/** What the curator works on, after parsing fills the defaults in. */
export type ParsedDelta = z.output<typeof PlaybookDeltaSchema>;
export type AddDelta = z.output<typeof addDelta>;
