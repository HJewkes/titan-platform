import { describe, expect, it } from "vitest";
import { COMPANION_FILE, companionLinkSlots, type ChapterLinks } from "./companion.js";

const linkTo = (chapter: string, section: string) => ({ chapter, section, href: `${COMPANION_FILE}#${section}`, facts: [] });

describe("a chapter's companion-link card", () => {
  it("takes its section's title, or the contents' for an unmapped chapter", () => {
    const links: ChapterLinks = { schema: "explainer.chapter-links/v1", doc: COMPANION_FILE, docSha: "d".repeat(64), links: [linkTo("ch1", "health"), linkTo("ch2", "contents")] };

    const slots = ["ch1", "ch2", "ch3"].map((chapter) => companionLinkSlots(links, chapter));

    expect(slots).toEqual([
      { title: "Health", section: "health", href: `${COMPANION_FILE}#health` },
      { title: "Contents", section: "contents", href: `${COMPANION_FILE}#contents` },
      undefined,
    ]);
  });
});
