import type { Audience, OwnerItem } from "./schema.js";

/** Items filed before `audience` existed carry none and stay owner items. */
export function audienceOf(item: Pick<OwnerItem, "audience">): Audience {
  return item.audience ?? "owner";
}

/** Keeps the items for `audience`, in input order. */
export function forAudience<T extends Pick<OwnerItem, "audience">>(items: readonly T[], audience: Audience): T[] {
  return items.filter((item) => audienceOf(item) === audience);
}
