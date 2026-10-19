import type { ReactNode } from "react";
import { Alert, DateTime, EmptyState, HStack, Link, Pill, Section, SectionContent, SectionHeader, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";

export type VideoRow = ConsoleCommands["videos.list"]["result"]["videos"][number];
type Verdict = NonNullable<VideoRow["verdict"]>;

export const VERDICT_LABELS: Record<Verdict, string> = { ship: "Ship", "needs-changes": "Needs changes" };

/** Every rendered video under the configured roots, grouped by folder, newest first. */
export function TheaterPage(): ReactNode {
  const list = useQuery("videos.list");
  if (list.status === "loading") return <Spinner size="sm" label="Loading videos" />;
  if (list.data === undefined) return <Alert status="error" message={`Could not load videos: ${list.error.message}`} />;
  const { videos, truncated, gaps } = list.data;
  return (
    <VStack gap={6}>
      {gaps.map((gap) => (
        <Alert key={gap} status="warning" message={gap} testID="theater-gap" />
      ))}
      {truncated ? <Alert status="warning" message={`Showing the first ${videos.length} videos; the roots hold more.`} /> : null}
      {videos.length === 0 ? <EmptyState title="No videos yet" description="The theater lists every mp4 and webm under TITAN_CONSOLE_VIDEO_ROOTS." /> : null}
      {groupVideos(videos).map(([group, rows]) => (
        <VideoGroup key={group} group={group} videos={rows} />
      ))}
    </VStack>
  );
}

/** The server sorts newest first, so a group's first appearance orders the groups by their newest render. */
function groupVideos(videos: readonly VideoRow[]): [string, VideoRow[]][] {
  const groups = new Map<string, VideoRow[]>();
  for (const video of videos) groups.set(video.group, [...(groups.get(video.group) ?? []), video]);
  return [...groups];
}

function VideoGroup({ group, videos }: { group: string; videos: readonly VideoRow[] }): ReactNode {
  return (
    <Section testID={`theater-group-${group}`}>
      <SectionHeader title={group || "Top level"} />
      <SectionContent>
        <VStack>
          {videos.map((video) => (
            <VideoCard key={video.id} video={video} />
          ))}
        </VStack>
      </SectionContent>
    </Section>
  );
}

function VideoCard({ video }: { video: VideoRow }): ReactNode {
  return (
    <VStack gap={1} className="border-b border-divider px-inset-md py-inset-sm" testID={`theater-video-${video.id}`}>
      <HStack gap={2} align="center" wrap>
        <Link color="primary" onPress={() => open({ view: "theater", id: video.id })}>
          {video.title}
        </Link>
        <VideoBadges video={video} />
      </HStack>
      <HStack gap={3} align="center" wrap>
        <DateTime value={video.modifiedAt} format="datetime" variant="caption" color="secondary" fallback="unknown" />
        <Typography variant="caption" color="secondary">
          {formatBytes(video.bytes)}
        </Typography>
      </HStack>
    </VStack>
  );
}

export function VideoBadges({ video }: { video: VideoRow }): ReactNode {
  return (
    <>
      {video.verdict ? (
        <Pill variant="subtle" size="xs">
          {VERDICT_LABELS[video.verdict]}
        </Pill>
      ) : null}
      {video.noteCount > 0 ? (
        <Pill variant="subtle" size="xs">
          {video.noteCount === 1 ? "1 note" : `${video.noteCount} notes`}
        </Pill>
      ) : null}
      {video.captions ? (
        <Pill variant="subtle" size="xs">
          CC
        </Pill>
      ) : null}
    </>
  );
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
