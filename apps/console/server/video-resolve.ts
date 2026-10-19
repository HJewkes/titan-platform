interface Resolvable {
  id: string;
  series?: string;
  tags?: string[];
  subject?: { kind: string; id: string };
  alias?: string;
  superseded: boolean;
  modifiedAt: string;
}

interface ResolveArgs {
  series?: string;
  tag?: string;
  subject?: string;
  alias?: string;
}

type Resolved = { found: true; id: string } | { found: false; reason: string };

/** `subject` matches the subject's id, so `lantern` finds a repo, day or initiative named so. */
function matches(video: Resolvable, { series, tag, subject }: ResolveArgs): boolean {
  return (
    (series === undefined || video.series === series) &&
    (tag === undefined || (video.tags?.includes(tag) ?? false)) &&
    (subject === undefined || video.subject?.id === subject)
  );
}

/** Over the rows the list already built, which are newest first, so the first match is the newest. */
export function resolveVideo(videos: readonly Resolvable[], args: ResolveArgs): Resolved {
  if (args.alias !== undefined) {
    const named = videos.find((video) => video.alias === args.alias);
    return named === undefined ? { found: false, reason: `No video has the alias ${args.alias}` } : { found: true, id: named.id };
  }
  const newest = videos.find((video) => !video.superseded && matches(video, args));
  return newest === undefined ? { found: false, reason: "No current video matches" } : { found: true, id: newest.id };
}
