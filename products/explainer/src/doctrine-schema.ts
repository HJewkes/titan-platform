import { z } from "zod";

/** Scope (VT §4.1): U universal, U* universal with a profile-supplied value, B beat or render, T type. */
export const DOCTRINE_LAYERS = ["U", "U*", "B", "T"] as const;

/** Enforcement (VT §5.1 a–f): where a rule is applied. */
export const DOCTRINE_ENFORCEMENTS = ["token", "component", "lint", "gate", "planner", "packet", "base", "human"] as const;

/** The enforcements that put a rule's text into a model prompt. */
export const PROMPT_ENFORCEMENTS = ["planner", "packet", "base"] as const satisfies readonly DoctrineEnforcement[];

export const DOCTRINE_STAGES = ["gather", "select", "plan", "script", "build", "render", "qa", "publish"] as const;

/** The seven craft doctrines; each has one `doctrine/craft/<doc>.yaml`. */
export const DOCTRINE_SOURCES = [
  "direction",
  "story-structure",
  "creator-craft",
  "talks-and-slides",
  "visual-information-design",
  "explainer-motion-craft",
  "skills-and-taste",
] as const;

export const DOCTRINE_GRADES = ["A", "B", "C", "D"] as const;

export type DoctrineLayer = (typeof DOCTRINE_LAYERS)[number];
export type DoctrineEnforcement = (typeof DOCTRINE_ENFORCEMENTS)[number];
export type DoctrineStage = (typeof DOCTRINE_STAGES)[number];
export type DoctrineSource = (typeof DOCTRINE_SOURCES)[number];
export type DoctrineGrade = (typeof DOCTRINE_GRADES)[number];

const Kebab = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "expected a kebab-case name");
const Names = z.array(Kebab).min(1);

const ScopeSchema = z
  .object({ layer: z.enum(DOCTRINE_LAYERS), beats: Names.optional(), types: Names.optional(), audiences: Names.optional() })
  .strict();

const CheckSchema = z
  .object({ kind: z.enum(["gate", "lint", "schema", "qrule"]), ref: z.string().min(1), live: z.boolean() })
  .strict();

const TokenRefSchema = z.object({ name: z.string().min(1), live: z.boolean() }).strict();

/**
 * One craft rule. Shape only: the cross-field and cross-file refinements (layer scope, evidence,
 * grades, enforcement leaks, qrule refs) are `checkDoctrine` issues, so one run reports them all.
 */
export const DoctrineRuleSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*(\.\d+)?$/, "expected <src>-<ref>[.<n>], such as dir-P1 or story-19"),
    source: z.object({ doc: z.enum(DOCTRINE_SOURCES), ref: z.string().min(1) }).strict(),
    text: z.string().min(1),
    grade: z.enum(DOCTRINE_GRADES).optional(),
    evidence: z.array(z.string().regex(/^E\d+$/, "expected an evidence-ledger id such as E01")).default([]),
    scope: ScopeSchema,
    enforcement: z.array(z.enum(DOCTRINE_ENFORCEMENTS)).min(1),
    stages: z.array(z.enum(DOCTRINE_STAGES)).min(1),
    check: CheckSchema.optional(),
    tokens: z.array(TokenRefSchema).min(1).optional(),
    param: z.string().min(1).optional(),
    supersedes: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type DoctrineRule = z.infer<typeof DoctrineRuleSchema>;

/** The allowed scope values: beat types, video types and audiences. */
export const DoctrineVocabularySchema = z
  .object({ schema: z.literal("doctrine-vocabulary/v1"), beats: Names, types: Names, audiences: Names })
  .strict();

export type DoctrineVocabulary = z.infer<typeof DoctrineVocabularySchema>;

/** A craft file before its rules are validated one by one, so an error can name the rule. */
export const CraftFileSchema = z.object({ schema: z.literal("doctrine-craft/v1"), rules: z.array(z.unknown()) }).strict();

export interface DoctrineRegistry {
  vocabulary: DoctrineVocabulary;
  /** Evidence-ledger id to the grades its row states; a compound cell such as "C (bounds) / D (bands)" gives both. */
  evidence: ReadonlyMap<string, readonly DoctrineGrade[]>;
  rules: DoctrineRule[];
}
