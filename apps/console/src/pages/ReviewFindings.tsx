import { useState, type ReactNode } from "react";
import { Card, CardContent, Chip, EmptyState, HStack, ListItem, Pill, Typography, VStack } from "@titan-design/react-ui";
import { TOPIC_PRIORITIES, TOPIC_VERDICTS } from "@titan-design/pm";
import type { getReview } from "../../server/reviews.js";

type TopicRow = Awaited<ReturnType<typeof getReview>>["topics"][number];

const FILTER_KEYS = ["P1+P2", "P3", "P4", "All"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
const FILTERS: Record<FilterKey, readonly string[] | null> = { "P1+P2": ["P1", "P2"], P3: ["P3"], P4: ["P4"], All: null };
/** The plan's default: the P1 and P2 load is what the owner acts on, so lower priorities wait behind a chip. */
const DEFAULT_FILTER: FilterKey = "P1+P2";

const SORTS = ["priority", "verdict", "tier", "title"] as const;
type SortKey = (typeof SORTS)[number];

/** Rows are one fixed height, so the window is arithmetic and needs no layout measurement. */
const ROW_HEIGHT = 56;
const VIEWPORT_HEIGHT = 448;
const OVERSCAN = 4;

/** An unknown value sorts after every known one rather than first, so a typo never jumps the queue. */
function rank(vocabulary: readonly string[], value: string): number {
  const at = vocabulary.indexOf(value);
  return at === -1 ? vocabulary.length : at;
}

const byPriority = (a: TopicRow, b: TopicRow): number => rank(TOPIC_PRIORITIES, a.priority) - rank(TOPIC_PRIORITIES, b.priority);
const byVerdict = (a: TopicRow, b: TopicRow): number => rank(TOPIC_VERDICTS, a.verdict) - rank(TOPIC_VERDICTS, b.verdict);

const COMPARATORS: Record<SortKey, (a: TopicRow, b: TopicRow) => number> = {
  priority: (a, b) => byPriority(a, b) || byVerdict(a, b) || a.line - b.line,
  verdict: (a, b) => byVerdict(a, b) || byPriority(a, b) || a.line - b.line,
  tier: (a, b) => a.tier.localeCompare(b.tier) || byPriority(a, b) || a.line - b.line,
  title: (a, b) => a.title.localeCompare(b.title) || a.line - b.line,
};

function shownTopics(topics: readonly TopicRow[], filter: FilterKey, sort: SortKey): TopicRow[] {
  const allowed = FILTERS[filter];
  return topics.filter((topic) => allowed === null || allowed.includes(topic.priority)).sort(COMPARATORS[sort]);
}

/** The judged topics, filtered by priority and sorted; a few hundred rows render only the slice in view. */
export function ReviewFindings({ topics }: { topics: readonly TopicRow[] }): ReactNode {
  const [filter, setFilter] = useState<FilterKey>(DEFAULT_FILTER);
  const [sort, setSort] = useState<SortKey>("priority");
  const [selected, setSelected] = useState<number | null>(null);
  const shown = shownTopics(topics, filter, sort);
  const picked = shown.find((topic) => topic.line === selected);
  return (
    <VStack gap={3}>
      <ChipRow label="Show" options={FILTER_KEYS} value={filter} onChange={setFilter} testID="findings-filter" />
      <ChipRow label="Sort" options={SORTS} value={sort} onChange={setSort} testID="findings-sort" />
      <Typography variant="caption" color="secondary">{`${shown.length} of ${topics.length} topics`}</Typography>
      {shown.length === 0 ? (
        <EmptyState title="No topics at this priority" />
      ) : (
        <WindowedRows topics={shown} selected={selected} onSelect={(line) => setSelected(line === selected ? null : line)} />
      )}
      {picked ? <FindingDetail topic={picked} /> : null}
    </VStack>
  );
}

function ChipRow<T extends string>({ label, options, value, onChange, testID }: { label: string; options: readonly T[]; value: T; onChange: (next: T) => void; testID: string }): ReactNode {
  return (
    <HStack gap={2} align="center" wrap testID={testID}>
      <Typography variant="caption" color="secondary">{label}</Typography>
      {options.map((option) => (
        <Chip key={option} size="sm" variant={option === value ? "solid" : "outline"} color={option === value ? "primary" : "default"} onPress={() => onChange(option)}>
          {option}
        </Chip>
      ))}
    </HStack>
  );
}

function WindowedRows({ topics, selected, onSelect }: { topics: readonly TopicRow[]; selected: number | null; onSelect: (line: number) => void }): ReactNode {
  const [scrollTop, setScrollTop] = useState(0);
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(topics.length, Math.ceil((scrollTop + VIEWPORT_HEIGHT) / ROW_HEIGHT) + OVERSCAN);
  return (
    <div
      className="overflow-y-auto border-y border-divider"
      style={{ height: Math.min(topics.length * ROW_HEIGHT, VIEWPORT_HEIGHT) }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      data-testid="findings-window"
    >
      <div style={{ height: start * ROW_HEIGHT }} />
      {topics.slice(start, end).map((topic) => (
        <FindingRow key={topic.line} topic={topic} isSelected={topic.line === selected} onPress={() => onSelect(topic.line)} />
      ))}
      <div style={{ height: (topics.length - end) * ROW_HEIGHT }} />
    </div>
  );
}

function FindingRow({ topic, isSelected, onPress }: { topic: TopicRow; isSelected: boolean; onPress: () => void }): ReactNode {
  return (
    <ListItem onPress={onPress} className={isSelected ? "bg-surface-raised" : undefined} style={{ height: ROW_HEIGHT }} testID={`finding-${topic.topic_id}`}>
      <VStack gap={0} className="min-w-0 flex-1">
        <HStack gap={2} align="center">
          <Pill variant="subtle" size="xs">{topic.priority}</Pill>
          <Pill variant="outline" size="xs">{topic.verdict}</Pill>
          <Typography variant="caption" color="secondary" numberOfLines={1}>{`${topic.topic_id} · ${topic.tier}`}</Typography>
        </HStack>
        <Typography variant="body2" numberOfLines={1}>{topic.title}</Typography>
      </VStack>
    </ListItem>
  );
}

/** The tapped row in full: the window keeps rows one height, so the reason and evidence open below it rather than inline. */
function FindingDetail({ topic }: { topic: TopicRow }): ReactNode {
  const evidence = [["titan_evidence", topic.titan_evidence], ...Object.entries(topic.extra)].filter(([, value]) => value !== "");
  return (
    <Card testID="finding-detail">
      <CardContent>
        <VStack gap={2}>
          <Typography variant="subtitle2">{`${topic.topic_id}: ${topic.title}`}</Typography>
          <Typography variant="body2">{topic.reason || "No reason given."}</Typography>
          {evidence.map(([key, value]) => (
            <VStack key={key} gap={0}>
              <Typography variant="caption" color="secondary">{key}</Typography>
              <Typography variant="body2">{value}</Typography>
            </VStack>
          ))}
        </VStack>
      </CardContent>
    </Card>
  );
}
