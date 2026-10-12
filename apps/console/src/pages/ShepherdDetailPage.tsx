import type { ReactNode } from "react";
import { Alert, BreadcrumbItem, Breadcrumbs, HStack, Heading, Pill, Section, SectionContent, SectionHeader, Spinner, Typography, VStack } from "@titan-design/react-ui";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";
import { RowBadges, stageOf, type WatchRow } from "./ShepherdPage.js";

/** Splits `owner/repo#pr` at its last `#`; anything else names no PR. */
export function parsePrRef(ref: string): { repo: string; pr: number } | undefined {
  const at = ref.lastIndexOf("#");
  const repo = ref.slice(0, at);
  const pr = Number(ref.slice(at + 1));
  return at > 0 && /^[^/\s]+\/[^/\s]+$/.test(repo) && Number.isInteger(pr) && pr > 0 ? { repo, pr } : undefined;
}

/** One shepherded PR: its watch row, then every step, gate, hold and release its run recorded. */
export function ShepherdDetailPage({ id }: { id: string }): ReactNode {
  const target = parsePrRef(id);
  return <Framed id={id}>{target ? <Timeline {...target} id={id} /> : <Alert status="error" message={`${id} names no PR; a Shepherd route reads owner/repo#pr`} />}</Framed>;
}

function Timeline({ repo, pr, id }: { repo: string; pr: number; id: string }): ReactNode {
  const timeline = useQuery("shepherd.timeline", { repo, pr });
  if (timeline.status === "loading") return <Spinner size="sm" label="Loading the timeline" />;
  if (timeline.data === undefined) return <Alert status="error" message={`Could not load ${id}: ${timeline.error.message}`} />;
  return (
    <VStack gap={4}>
      <RowHeading row={timeline.data.row} />
      <EntriesSection entries={timeline.data.entries} />
    </VStack>
  );
}

function EntriesSection({ entries }: { entries: readonly unknown[] }): ReactNode {
  return (
    <Section>
      <SectionHeader title="Timeline" subtitle="Oldest first" />
      <SectionContent>
        <VStack gap={1}>
          {entries.length === 0 ? <Typography variant="body2" color="secondary">The run has recorded nothing yet.</Typography> : null}
          {entries.map((entry, index) => (
            <Typography key={index} variant="body2" testID={`shepherd-entry-${index}`}>
              {describeEntry(entry)}
            </Typography>
          ))}
        </VStack>
      </SectionContent>
    </Section>
  );
}

function Framed({ id, children }: { id: string; children: ReactNode }): ReactNode {
  return (
    <VStack gap={4}>
      <Breadcrumbs>
        <BreadcrumbItem onPress={() => open({ view: "shepherd" })}>Shepherd</BreadcrumbItem>
        <BreadcrumbItem isCurrentPage>{id}</BreadcrumbItem>
      </Breadcrumbs>
      {children}
    </VStack>
  );
}

function RowHeading({ row }: { row: WatchRow }): ReactNode {
  const stage = stageOf(row);
  return (
    <VStack gap={1}>
      <HStack gap={3} align="center" wrap>
        <Heading level={3}>{row.task}</Heading>
        <Pill variant="subtle" size="xs">
          {row.phase}
        </Pill>
        {stage ? <Typography variant="caption" color="secondary">{`${stage.name} · ${stage.minutes} min`}</Typography> : null}
        <RowBadges row={row} />
      </HStack>
      <Typography variant="body2" color="secondary">
        {`Next: ${row.nextAction}`}
      </Typography>
    </VStack>
  );
}

type Entry = Record<string, unknown>;

const text = (value: unknown): string => (value === null || value === undefined ? "–" : String(value));
const shortSha = (value: unknown): string => (typeof value === "string" ? value.slice(0, 7) : "–");
const suffix = (value: unknown, label: string): string => (value ? `${label}${text(value)}` : "");

/** One line per entry kind the console knows, after `TimelineEntrySchema` in titan-factory's shepherd/view.ts. */
const DESCRIBE: Readonly<Record<string, (e: Entry) => string>> = {
  step: (e) => `step ${text(e["stepId"])} #${text(e["iteration"])}: ${text(e["status"])}${suffix(e["signal"], ", signal ")}, ${text(e["completedAt"] ?? e["startedAt"])}`,
  ci: (e) => `ci ${text(e["conclusion"])} at ${shortSha(e["headSha"])}`,
  wake: (e) => `wake ${text(e["request"])}: ${text(e["outcome"])} ${text(e["agent"])}${suffix(e["held"], ", held: ")}`,
  verdict: (e) => `verdict ${text(e["verdict"])} by ${text(e["reviewer"])} at ${shortSha(e["headSha"])}`,
  gate: (e) => `gate ${text(e["stepId"])}: ${text(e["status"])}, opened ${text(e["createdAt"])}${suffix(e["resolvedBy"], ", resolved by ")}`,
  event: (e) => `${text(e["event"])} by ${text(e["actor"])} at ${text(e["at"])}${suffix(e["reason"], ": ")}`,
};

/** Shepherd adds entry kinds over time and the console's schema keeps them `unknown`, so a kind it does not know gets a fallback line. */
export function describeEntry(entry: unknown): string {
  if (typeof entry !== "object" || entry === null) return "Unrecognised entry";
  const e = entry as Entry;
  const kind = e["kind"];
  const describe = typeof kind === "string" && Object.hasOwn(DESCRIBE, kind) ? DESCRIBE[kind] : undefined;
  return describe ? describe(e) : `Unrecognised entry: ${text(kind)}`;
}
