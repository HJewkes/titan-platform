import type { VideoKind } from "./store.js";

export interface AtomEntry {
  id: string;
  title: string;
  published?: string;
  kind: VideoKind;
}

export class AtomParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtomParseError";
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const decode = (text: string): string => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ENTITIES[name]!);

const tagText = (xml: string, tag: string): string | undefined => {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return match ? decode(match[1]!.trim()) : undefined;
};

/** Parse a channel's Atom feed; a `/shorts/` alternate link marks a short. Throws `AtomParseError` when the text is not a feed. */
export function parseAtom(xml: string): AtomEntry[] {
  if (!/<feed[\s>]/.test(xml)) throw new AtomParseError("not an Atom feed");
  const entries: AtomEntry[] = [];
  for (const block of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const body = block[1]!;
    const id = tagText(body, "yt:videoId");
    if (!id) throw new AtomParseError("entry without a yt:videoId");
    const href = /<link[^>]*\brel="alternate"[^>]*\bhref="([^"]*)"/.exec(body)?.[1] ?? "";
    entries.push({ id, title: tagText(body, "title") ?? "", published: tagText(body, "published"), kind: href.includes("/shorts/") ? "short" : "vod" });
  }
  return entries;
}
