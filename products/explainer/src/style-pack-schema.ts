import { z } from "zod";

const Token = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "expected a token name without its leading --");

const StyleTokensSchema = z
  .object({
    ground: Token,
    surface: Token,
    text: Token,
    textMuted: Token,
    accent: Token,
    accentSoft: Token,
    rule: Token,
    lift: Token,
    grain: Token.optional(),
    heading: Token,
    body: Token,
    code: Token,
    duration: Token,
    ease: Token,
  })
  .strict();

export type StyleSlot = keyof z.infer<typeof StyleTokensSchema>;

/**
 * The token families each slot may pick from, by name prefix: a slot holds a token of its kind (a
 * colour for the ground, an ease for the motion), never a raw value.
 */
export const SLOT_FAMILIES: Record<StyleSlot, readonly string[]> = {
  ground: ["color-background-", "color-surface-"],
  surface: ["color-surface-", "color-background-", "elevation-"],
  text: ["color-text-"],
  textMuted: ["color-text-"],
  accent: ["color-brand-", "color-dataviz-categorical-"],
  accentSoft: ["color-brand-", "color-dataviz-categorical-"],
  rule: ["color-hairline-", "color-border-", "color-divider"],
  lift: ["lift-", "material-paper-shadow", "material-inset-shadow", "glow-"],
  grain: ["material-paper-grain"],
  heading: ["font-family-"],
  body: ["font-family-"],
  code: ["font-family-"],
  duration: ["duration-"],
  ease: ["ease-"],
};

/**
 * One style pack (video-profiles plan §A.2): a selection among existing titan-design tokens, judged
 * on rendered pilots (owner Q7 B). It holds names, never values, so a pack cannot add a token.
 */
export const StylePackSchema = z
  .object({
    schema: z.literal("style-pack/v1"),
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "expected a kebab-case id"),
    theme: z.enum(["dark", "light"]),
    feel: z.string().min(1),
    tokens: StyleTokensSchema,
  })
  .strict();

export type StylePack = z.infer<typeof StylePackSchema>;

/** `doctrine/style-tokens.json`: the token names of the tokens.css the template imports, pinned by script. */
export const StyleTokensFileSchema = z
  .object({
    source: z.object({ package: z.string(), subpath: z.string(), version: z.string() }).strict(),
    tokens: z.array(Token).min(1),
  })
  .strict();
