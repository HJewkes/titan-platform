import { z } from "zod";

const PollInterval = z.string().regex(/^[1-9]\d*[mhd]$/, "expected an interval like 30m, 3h or 1d");
const Tab = z.enum(["videos", "streams", "shorts"]);
const ChannelId = z.string().regex(/^UC[\w-]{22}$/, "expected a UC… channel id");

const CaseInsensitivePattern = z.string().refine((pattern) => {
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}, "not a valid regular expression");

const DefaultsSchema = z.strictObject({
  poll: PollInterval,
  tabs: z.array(Tab).min(1),
  min_seconds: z.int().nonnegative(),
  max_seconds: z.int().positive(),
});

/**
 * One watched source: a channel (`channel_id`, polled per tab) or a name search
 * (`search`, kept only when the title or channel matches `match`, case-insensitively).
 */
export const SourceSchema = z
  .strictObject({
    key: z.string().min(1),
    name: z.string().min(1),
    channel_id: ChannelId.optional(),
    handle: z.string().min(1).optional(),
    search: z.string().min(1).optional(),
    match: CaseInsensitivePattern.optional(),
    tabs: z.array(Tab).min(1).optional(),
    poll: PollInterval.optional(),
    trial_until: z.iso.date().optional(),
  })
  .refine((s) => (s.channel_id === undefined) !== (s.search === undefined), {
    message: "a source needs exactly one of channel_id or search",
  })
  .refine((s) => s.search === undefined || s.match !== undefined, {
    message: "a search source needs a match pattern",
    path: ["match"],
  });

export const WatchlistSchema = z
  .strictObject({
    version: z.literal(1),
    defaults: DefaultsSchema,
    sources: z.array(SourceSchema).min(1),
    scoring: z.strictObject({
      threshold_total: z.int().min(0).max(15),
      also_if_any_axis: z.int().min(1).max(5),
      daily_top: z.int().positive(),
    }),
    budget: z.strictObject({ daily_usd: z.number().positive(), backfill_usd: z.number().positive() }),
    models: z.strictObject({ score: z.string().min(1), digest: z.string().min(1) }),
    yt_dlp: z.string().min(1).optional(),
  })
  .superRefine((w, ctx) => {
    const seen = new Set<string>();
    w.sources.forEach((s, i) => {
      if (seen.has(s.key)) ctx.addIssue({ code: "custom", message: `duplicate source key "${s.key}"`, path: ["sources", i, "key"] });
      seen.add(s.key);
    });
  });

export type Source = z.infer<typeof SourceSchema>;
export type Watchlist = z.infer<typeof WatchlistSchema>;

/** A trial source is still on trial until the end of its `trial_until` day. */
export function isOnTrial(source: Source, today: string): boolean {
  return source.trial_until !== undefined && today <= source.trial_until;
}
