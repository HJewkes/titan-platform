import { useState, type ReactNode } from "react";
import { Button, ButtonText, Chip, DateTime, EmptyState, HStack, Input, Link, Pill, Section, SectionContent, SectionHeader, Typography, VStack } from "@titan-design/react-ui";
import { open, replace, type Route } from "../router.js";
import {
  PURPOSES,
  PURPOSE_DOTS,
  PURPOSE_LABELS,
  feedQuery,
  formatRunTime,
  sectionSubtitle,
  splitMatches,
  type DaySection,
  type FeedRow,
  type FeedState,
  type Purpose,
  type VideoRow,
} from "./theater-feed.js";

export const VERDICT_LABELS: Record<NonNullable<VideoRow["verdict"]>, string> = { ship: "Ship", "needs-changes": "Needs changes" };

function feedRoute(state: FeedState): Route {
  const query = feedQuery(state);
  return { view: "theater", ...(query ? { query } : {}) };
}

function Dot({ className }: { className: string }): ReactNode {
  return (
    <HStack aria-hidden className={`h-2 w-2 rounded-full ${className}`}>
      {null}
    </HStack>
  );
}

/** The label always reads on its own; the dot only repeats it in colour. */
function PurposePill({ purpose }: { purpose: Purpose }): ReactNode {
  const dot = PURPOSE_DOTS[purpose];
  return (
    <Pill variant="subtle" tone="neutral" size="sm" leading={dot === null ? undefined : <Dot className={dot} />}>
      {PURPOSE_LABELS[purpose]}
    </Pill>
  );
}

/** At most one flag, so a row carries no more than two pills of its own. */
function FlagPill({ video }: { video: VideoRow }): ReactNode {
  const flag = video.superseded ? "Old take" : video.orientation === "portrait" ? "Phone" : null;
  if (flag === null) return null;
  return (
    <Pill variant="outline" tone="neutral" size="sm">
      {flag}
    </Pill>
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

/** Matches in bold, with no fill, as titan highlights a search hit. */
function Highlighted({ text, q }: { text: string; q: string }): ReactNode {
  return splitMatches(text, q).map((part, index) =>
    part.match ? (
      <Typography key={index} color="inherit" className="font-bold" testID="theater-match">
        {part.text}
      </Typography>
    ) : (
      part.text
    ),
  );
}

function Byline({ video }: { video: VideoRow }): ReactNode {
  const copies = video.copies === 1 ? "1 copy" : video.copies > 1 ? `${video.copies} copies` : null;
  const parts = [video.subject?.id ?? (video.group || "Top level"), video.durationS === null ? null : formatRunTime(video.durationS), copies];
  return (
    <HStack gap={2} align="center" wrap>
      <Typography variant="caption" color="secondary">
        {parts.filter((part) => part !== null).join(" · ")}
      </Typography>
      <DateTime value={video.modifiedAt} format="time" variant="caption" color="secondary" fallback="" />
    </HStack>
  );
}

function FeedVideo({ row, q }: { row: FeedRow; q: string }): ReactNode {
  const { video, purpose } = row;
  return (
    <VStack gap={1} className="border-b border-divider px-inset-md py-inset-sm" testID={`theater-video-${video.id}`}>
      <Link color="primary" onPress={() => open({ view: "theater", id: video.id })}>
        <Highlighted text={video.title} q={q} />
      </Link>
      <HStack gap={2} align="center" wrap>
        <PurposePill purpose={purpose} />
        <FlagPill video={video} />
        <VideoBadges video={video} />
      </HStack>
      <Byline video={video} />
    </VStack>
  );
}

export function DayFeedSection({ section, state }: { section: DaySection; state: FeedState }): ReactNode {
  const clips = section.hiddenClips === 1 ? "1 clip" : `${section.hiddenClips} clips`;
  const trailing = section.hiddenClips > 0 ? <Link onPress={() => open(feedRoute({ ...state, purpose: "clip" }))}>{clips}</Link> : undefined;
  return (
    <Section testID={`theater-day-${section.key || "undated"}`}>
      <SectionHeader title={section.name} subtitle={sectionSubtitle(section)} trailing={trailing} />
      <SectionContent>
        <VStack>
          {section.rows.map((row) => (
            <FeedVideo key={row.video.id} row={row} q={state.q} />
          ))}
        </VStack>
      </SectionContent>
    </Section>
  );
}

/** Types into the URL by replacement, and follows it when a chip or Clear changes `?q=` from outside. */
export function SearchField({ state }: { state: FeedState }): ReactNode {
  const [draft, setDraft] = useState(state.q);
  const [seen, setSeen] = useState(state.q);
  if (state.q !== seen) {
    setSeen(state.q);
    setDraft(state.q);
  }
  const change = (text: string): void => {
    setDraft(text);
    replace(feedRoute({ ...state, q: text }));
  };
  return <Input value={draft} onChangeText={change} placeholder="Search" accessibilityLabel="Search videos" variant="filled" size="lg" className="rounded-full" testID="theater-search" />;
}

function FilterChip({ label, dot, selected, onPress, testID }: { label: string; dot?: string | null; selected: boolean; onPress: () => void; testID: string }): ReactNode {
  return (
    <Chip variant={selected ? "solid" : "subtle"} size="lg" leftElement={dot ? <Dot className={dot} /> : undefined} onPress={onPress} accessibilityState={{ selected }} testID={testID}>
      {label}
    </Chip>
  );
}

/** Single select; tapping the selected chip again goes back to All. */
export function PurposeChips({ state, counts }: { state: FeedState; counts: Record<Purpose, number> }): ReactNode {
  const select = (purpose: Purpose | null) => open(feedRoute({ ...state, purpose }));
  return (
    <HStack gap={2} align="center" wrap>
      <FilterChip label="All" selected={state.purpose === null} onPress={() => select(null)} testID="theater-chip-all" />
      {PURPOSES.map((purpose) => (
        <FilterChip
          key={purpose}
          label={`${PURPOSE_LABELS[purpose]} ${counts[purpose]}`}
          dot={PURPOSE_DOTS[purpose]}
          selected={state.purpose === purpose}
          onPress={() => select(state.purpose === purpose ? null : purpose)}
          testID={`theater-chip-${purpose}`}
        />
      ))}
    </HStack>
  );
}

export function NoMatches({ state }: { state: FeedState }): ReactNode {
  const what = [state.q.trim() && `“${state.q.trim()}”`, state.purpose && PURPOSE_LABELS[state.purpose]].filter(Boolean).join(" in ");
  const action = (
    <Button variant="outline" size="sm" onPress={() => open({ view: "theater" })} testID="theater-clear">
      <ButtonText>Clear</ButtonText>
    </Button>
  );
  return <EmptyState title="No matches" description={what || "Nothing here yet."} action={action} />;
}

/** The old-takes toggle and the folded-copies count; a search already reaches both, so it shows neither. */
export function FeedFooter({ videos, state }: { videos: readonly VideoRow[]; state: FeedState }): ReactNode {
  const old = videos.filter((video) => video.superseded).length;
  const copies = videos.reduce((sum, video) => sum + video.copies, 0);
  if (state.q.trim() !== "" || (old === 0 && copies === 0)) return null;
  return (
    <HStack gap={4} align="center" wrap>
      {old > 0 ? (
        <Link onPress={() => open(feedRoute({ ...state, old: !state.old }))} testID="theater-old-toggle">
          {state.old ? "Hide old takes" : old === 1 ? "Show 1 old take" : `Show ${old} old takes`}
        </Link>
      ) : null}
      {copies > 0 ? (
        <Typography variant="caption" color="secondary">
          {copies === 1 ? "1 copy folded" : `${copies} copies folded`}
        </Typography>
      ) : null}
    </HStack>
  );
}
