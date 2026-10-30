import type { ReactNode } from "react";
import { Alert, Badge, BadgeText, HStack, Section, SectionContent, SectionHeader, Skeleton, Typography, VStack } from "@titan-design/react-ui";
import { useQuery, type ServedCommands } from "../data/rpc.js";

type PoolsResult = ServedCommands["coord.pools"]["result"];
type PoolAccount = PoolsResult["accounts"][number];
type DayArgs = ServedCommands["coord.pools"]["args"];

const METER_SKELETONS = 3;

/** The gaps `coord.pools` reports, by the file that caused them, and what each one leaves unknown on the meters. */
const GAP_MEANINGS: readonly [prefix: string, meaning: string][] = [
  ["pace.json", "agent-chat's pace.json could not be read, so no account shows its current use, glide target or level."],
  ["pool-readings.jsonl", "The pool-readings history could not be read, so the split into before today and today, and the per-day guard, are unknown."],
  ["charter.md", "The charter could not be read, so the reserve line and the per-day guard are unknown."],
  ["coordinator roots", "The console has no agent-chat or autonomy directory configured, so no account can be read."],
];

export function explainPoolGap(gap: string): string {
  return GAP_MEANINGS.find(([prefix]) => gap.startsWith(prefix))?.[1] ?? gap;
}

const percent = (value: number | null): string => (value === null ? "unknown" : `${Math.round(value)}%`);
const clamp = (value: number): number => Math.min(100, Math.max(0, value));

/** One meter per agent-chat account: its seven-day use before the day and during it, against the reserve line, glide target and per-day guard. */
export function CoordinatorPools({ day }: { day: DayArgs }): ReactNode {
  const pools = useQuery("coord.pools", day);
  return (
    <Section>
      <SectionHeader title="Pools" subtitle="Seven-day use per account, before this day and during it" />
      <SectionContent>
        {pools.status === "loading" ? (
          <PoolsSkeleton />
        ) : pools.data === undefined ? (
          <Alert status="error" message={`Could not load the pool meters: ${pools.error.message}`} testID="coord-pools-error" />
        ) : (
          <PoolsBody result={pools.data} />
        )}
      </SectionContent>
    </Section>
  );
}

function PoolsSkeleton(): ReactNode {
  return (
    <VStack gap={3} testID="coord-pools-loading">
      {Array.from({ length: METER_SKELETONS }, (_, index) => (
        <Skeleton key={index} variant="rounded" width="100%" height={56} accessibilityLabel={index === 0 ? "Loading the pool meters" : undefined} />
      ))}
    </VStack>
  );
}

function PoolsBody({ result }: { result: PoolsResult }): ReactNode {
  return (
    <VStack gap={4}>
      {result.gaps.map((gap) => (
        <Alert key={gap} status="warning" message={explainPoolGap(gap)} testID="coord-pools-gap">
          <Typography variant="caption" color="secondary" className="break-words">
            {gap}
          </Typography>
        </Alert>
      ))}
      {result.accounts.length === 0 ? (
        <Typography variant="body2" color="secondary">
          No account to show: agent-chat has written no pace.json and the charter names no pool.
        </Typography>
      ) : (
        result.accounts.map((account) => <PoolMeter key={account.pool} account={account} />)
      )}
    </VStack>
  );
}

function PoolMeter({ account }: { account: PoolAccount }): ReactNode {
  const name = account.members.length > 1 ? `${account.pool} (${account.members.join(", ")})` : account.pool;
  return (
    <VStack gap={1} className="min-w-0" testID={`coord-meter-${account.pool}`}>
      <HStack gap={2} align="center" className="min-w-0 flex-wrap">
        <Typography variant="subtitle2" className="break-words">
          {name}
        </Typography>
        <LevelBadge level={account.level} />
        {account.stale === true ? <PoolBadge color="warning" label="stale" testID={`coord-meter-stale-${account.pool}`} /> : null}
      </HStack>
      {account.error === undefined ? <MeterBar account={account} /> : null}
      <Typography variant="caption" color="secondary" className="break-words">
        {account.error ?? meterCaption(account)}
      </Typography>
    </VStack>
  );
}

function meterCaption(account: PoolAccount): string {
  const split = account.beforeToday === null || account.today === null ? `${percent(account.current)} used; no history to split it by day` : `${percent(account.beforeToday)} before today + ${percent(account.today)} today = ${percent(account.current)}`;
  return [split, `reserve line ${percent(account.reserveLine)}`, `target ${percent(account.target)}`, `per-day guard ${percent(account.perDayGuard)}`].join(" · ");
}

/** agent-chat's pace levels; `behind` and `burn` mean spare budget to spend, so only `at_risk` and `stale` warn. */
const LEVEL_COLORS: Readonly<Record<string, "success" | "warning">> = { on_pace: "success", at_risk: "warning", stale: "warning" };

function LevelBadge({ level }: { level: string | null }): ReactNode {
  if (level === null) return null;
  return <PoolBadge color={LEVEL_COLORS[level] ?? "default"} label={level.replaceAll("_", " ")} />;
}

function PoolBadge({ color, label, testID }: { color: "default" | "success" | "warning" | "error"; label: string; testID?: string }): ReactNode {
  return (
    <Badge color={color} variant="subtle" size="sm" testID={testID}>
      <BadgeText>{label}</BadgeText>
    </Badge>
  );
}

interface Marker {
  key: string;
  label: string;
  value: number | null;
  className: string;
}

/** With no history the whole reading is drawn as before today, since the split is what is unknown. */
function MeterBar({ account }: { account: PoolAccount }): ReactNode {
  const before = clamp(account.beforeToday ?? account.current ?? 0);
  const today = clamp(Math.min(account.today ?? 0, 100 - before));
  const markers: Marker[] = [
    { key: "reserve", label: "Reserve line", value: account.reserveLine, className: "border-status-warning" },
    { key: "target", label: "Glide target", value: account.target, className: "border-dashed border-text-secondary" },
    { key: "guard", label: "Per-day guard", value: account.perDayGuard, className: "border-status-error" },
  ];
  return (
    <div className="relative h-3 w-full overflow-hidden rounded border border-hairline-strong bg-surface-raised" role="img" aria-label={`${account.pool}: ${meterCaption(account)}`}>
      <div className="absolute inset-y-0 left-0 bg-data-2" style={{ width: `${before}%` }} data-testid={`coord-meter-before-${account.pool}`} />
      <div className="absolute inset-y-0 bg-brand-primary" style={{ left: `${before}%`, width: `${today}%` }} data-testid={`coord-meter-today-${account.pool}`} />
      {markers.map((marker) =>
        marker.value === null ? null : (
          <div key={marker.key} title={`${marker.label} ${percent(marker.value)}`} className={`absolute inset-y-0 border-l-2 ${marker.className}`} style={{ left: `${clamp(marker.value)}%` }} data-testid={`coord-marker-${marker.key}-${account.pool}`} />
        ),
      )}
    </div>
  );
}
