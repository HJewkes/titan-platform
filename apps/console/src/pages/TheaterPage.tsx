import type { ReactNode } from "react";
import { Alert, EmptyState, Spinner, VStack } from "@titan-design/react-ui";
import { useQuery } from "../data/rpc.js";
import { DayFeedSection, FeedFooter, NoMatches, PurposeChips, SearchField } from "./TheaterFeed.js";
import { feedStateOf, groupByDay, purposeCounts, searchedRows, shownRows, type FeedState, type VideoRow } from "./theater-feed.js";

/** Every rendered video under the configured roots, by publish day in the reader's timezone, newest first. */
export function TheaterPage({ query }: { query?: string }): ReactNode {
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
      {videos.length === 0 ? (
        <EmptyState title="No videos yet" description="The theater lists every mp4 and webm under TITAN_CONSOLE_VIDEO_ROOTS." />
      ) : (
        <Feed videos={videos} state={feedStateOf(query)} />
      )}
    </VStack>
  );
}

function Feed({ videos, state }: { videos: readonly VideoRow[]; state: FeedState }): ReactNode {
  const searched = searchedRows(videos, state);
  const browsing = state.purpose === null && state.q.trim() === "";
  const hiddenClips = browsing ? searched.filter((row) => row.purpose === "clip") : [];
  const sections = groupByDay(shownRows(searched, state), hiddenClips, { now: new Date() });
  return (
    <VStack gap={4}>
      <SearchField state={state} />
      <PurposeChips state={state} counts={purposeCounts(searched)} />
      {sections.length === 0 ? <NoMatches state={state} /> : sections.map((section) => <DayFeedSection key={section.key} section={section} state={state} />)}
      <FeedFooter videos={videos} state={state} />
    </VStack>
  );
}
