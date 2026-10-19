import { useState, type ReactNode } from "react";
import { Alert, Badge, BadgeText, Button, ButtonText, Card, CardContent, EmptyState, HStack, Link, Pill, Section, SectionContent, SectionHeader, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { useAnswerSource } from "../data/submit.js";
import { open, parseRoute } from "../router.js";
import { openExternal } from "./homeLinks.js";
import { InboxConfirm } from "./InboxConfirm.js";

export type InboxItem = ConsoleCommands["inbox.list"]["result"]["items"][number];
type InboxAction = InboxItem["action"];
type DerivedRow = ConsoleCommands["inbox.list"]["result"]["derived"][number];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function ageOf(openedAt: string, now: number = Date.now()): string {
  const ms = Math.max(0, now - Date.parse(openedAt));
  if (ms >= DAY) return `${Math.floor(ms / DAY)}d`;
  if (ms >= HOUR) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / MINUTE)}m`;
}

const RELEASE_GATE = /shepherd-release\//;

/** The source badge: what kind of thing is waiting, read from where the item came from. */
export function badgeOf(item: InboxItem): { label: string; color: "info" | "warning" | "error" | "primary" | "secondary" | "default" } {
  const source = item.sources[0]!;
  if (source.system === "hitl") {
    if (item.hold !== undefined) return { label: "hold", color: "warning" };
    return RELEASE_GATE.test(source.ref) || item.keys.some((key) => RELEASE_GATE.test(key)) ? { label: "release", color: "error" } : { label: "gate", color: "primary" };
  }
  if (source.system === "agent-chat") return { label: "ask", color: "info" };
  if (source.system === "round") return { label: "round", color: "secondary" };
  if (source.system === "morning") return { label: "Morning", color: "default" };
  if (source.system === "active-work") return { label: "task", color: "default" };
  return { label: "terminal", color: "default" };
}

function recommendationOf(item: InboxItem): string | undefined {
  const pick = item.recommended?.optionId;
  if (pick === undefined) return undefined;
  return item.options?.find((option) => option.id === pick)?.label ?? pick;
}

/**
 * The command a terminal runs for a tap the console does not take yet. A held gate's release mirrors the server's
 * `releaseCommand` in inbox-view.ts; every other write runs the item's own command.
 */
function terminalCommandOf(item: InboxItem, action: InboxAction = item.action): string | undefined {
  if (action.kind === "terminal") return action.command;
  if (action.kind === "owner-release") return `titan-factory shepherd owner-release ${action.repo}#${action.pr} --head ${action.headSha}`;
  if (action.kind === "hold-release") return `titan-factory shepherd release ${action.repo}#${action.pr} --head ${action.headSha} --class ${action.holdClass}`;
  return item.command;
}

const VERB: Record<InboxAction["kind"], string> = {
  "resolve-gate": "Approve merge",
  "owner-release": "Release hold",
  "hold-release": "Release hold",
  "answer-chat": "Answer",
  "open-round": "Open round",
  open: "Open",
  terminal: "Run on terminal",
};

/** Navigation stays a link; a write the console does not take yet is shown as its terminal command. */
const isNavigation = (action: InboxAction): boolean => action.kind === "open" || action.kind === "open-round";

/** The writes the page taps through `inbox.act`; `answer-chat` waits on a sheet that takes the answer's text. */
const CONSOLE_TAPS: ReadonlySet<InboxAction["kind"]> = new Set(["resolve-gate", "owner-release"]);

function followEvidence(evidence: string): void {
  if (evidence.startsWith("#")) open(parseRoute(evidence));
  else openExternal(evidence);
}

/** Every pending owner decision in one list: blocking first, then planning collapsed, then a count of FYIs. */
export function InboxPage(): ReactNode {
  const inbox = useQuery("inbox.list");
  if (inbox.status === "loading") return <Spinner size="sm" label="Loading the inbox" />;
  if (inbox.data === undefined) return <Alert status="error" message={`Could not load the inbox: ${inbox.error.message}`} />;
  const { items, gaps, fyiCount, derived } = inbox.data;
  const blocking = items.filter((item) => item.section === "blocking");
  const planning = items.filter((item) => item.section === "planning");
  return (
    <VStack gap={6}>
      <GapBanners gaps={gaps} />
      <BlockingSection items={blocking} quiet={planning.length === 0 && derived.length === 0} gapped={gaps.length > 0} />
      {derived.length > 0 ? <DerivedSection rows={derived} /> : null}
      {planning.length > 0 ? <PlanningSection items={planning} /> : null}
      <Typography variant="caption" color="secondary" testID="inbox-fyi">{`FYI: ${fyiCount}`}</Typography>
    </VStack>
  );
}

function GapBanners({ gaps }: { gaps: readonly string[] }): ReactNode {
  return gaps.map((gap) => <Alert key={gap} status="warning" message={`A source is unreadable, so this list may be missing items: ${gap}`} testID="inbox-gap" />);
}

function BlockingSection({ items, quiet, gapped }: { items: readonly InboxItem[]; quiet: boolean; gapped: boolean }): ReactNode {
  // A dead leg leaves its items unknown, so an empty list may not claim nothing needs the owner.
  const empty = gapped ? null : <EmptyState title={quiet ? "Nothing needs you" : "Nothing is blocking"} />;
  return (
    <Section testID="inbox-blocking">
      <SectionHeader title={`Blocking (${items.length})`} subtitle="Newest first" />
      <SectionContent>{items.length === 0 ? empty : <InboxRows items={items} />}</SectionContent>
    </Section>
  );
}

const DERIVED_LABEL: Record<DerivedRow["kind"], string> = { "stalled-run": "stalled", "failed-run": "failed", "blocked-agent": "blocked" };

/** Exceptions the console derived itself, kept apart from what producers filed; each is a "go look" link with no action. */
function DerivedSection({ rows }: { rows: readonly DerivedRow[] }): ReactNode {
  return (
    <Section testID="inbox-derived">
      <SectionHeader title={`Raised by the console (${rows.length})`} subtitle="Machine-derived, with evidence; go look" />
      <SectionContent>
        <VStack gap={3}>
          {rows.map((row) => (
            <DerivedRowCard key={row.id} row={row} />
          ))}
        </VStack>
      </SectionContent>
    </Section>
  );
}

function DerivedRowCard({ row }: { row: DerivedRow }): ReactNode {
  const { evidence, threshold } = row;
  return (
    <Card variant="outline" testID={`inbox-derived-${row.id}`}>
      <CardContent>
        <VStack gap={2}>
          <Typography variant="subtitle2">{row.summary}</Typography>
          <HStack gap={2} align="center" wrap>
            <Badge color="warning" variant="subtle" size="sm">
              <BadgeText>{`machine: ${DERIVED_LABEL[row.kind]}`}</BadgeText>
            </Badge>
            <Typography variant="caption" color="secondary">{ageOf(evidence.at)}</Typography>
          </HStack>
          <Typography variant="caption">{`${evidence.observed} (${evidence.source}, since ${evidence.at})`}</Typography>
          <Typography variant="caption" color="secondary">{`Crossed: ${threshold.name}`}</Typography>
          <Link color="primary" onPress={() => open(parseRoute(row.link))}>
            {row.kind === "blocked-agent" ? "Open the agent" : "Open the run"}
          </Link>
        </VStack>
      </CardContent>
    </Card>
  );
}

/** Planning can run to hundreds of rows, so it opens only when asked. */
function PlanningSection({ items }: { items: readonly InboxItem[] }): ReactNode {
  const [isOpen, setOpen] = useState(false);
  return (
    <Section testID="inbox-planning">
      <SectionHeader title={`Planning (${items.length})`} subtitle="Answered at each item's source" />
      <SectionContent>
        <VStack gap={3}>
          <Button variant="outline" size="sm" onPress={() => setOpen(!isOpen)}>
            <ButtonText>{isOpen ? "Hide planning" : `Show ${items.length} planning items`}</ButtonText>
          </Button>
          {isOpen ? <InboxRows items={items} /> : null}
        </VStack>
      </SectionContent>
    </Section>
  );
}

function InboxRows({ items }: { items: readonly InboxItem[] }): ReactNode {
  return (
    <VStack gap={3}>
      {items.map((item) => (
        <InboxRow key={item.id} item={item} />
      ))}
    </VStack>
  );
}

function InboxRow({ item }: { item: InboxItem }): ReactNode {
  const badge = badgeOf(item);
  const recommendation = recommendationOf(item);
  return (
    <Card variant="outline" testID={`inbox-row-${item.id}`}>
      <CardContent>
        <VStack gap={2}>
          <Typography variant="subtitle2">{item.summary}</Typography>
          <HStack gap={2} align="center" wrap>
            <Badge color={badge.color} variant="subtle" size="sm">
              <BadgeText>{badge.label}</BadgeText>
            </Badge>
            <Typography variant="caption" color="secondary">{ageOf(item.openedAt)}</Typography>
            {recommendation !== undefined ? <Pill variant="subtle" size="xs">{`Recommend: ${recommendation}`}</Pill> : null}
            {item.hold !== undefined ? <Typography variant="caption" color="secondary">{item.hold.reason}</Typography> : null}
          </HStack>
          {item.evidence !== undefined ? <EvidenceLink evidence={item.evidence} /> : null}
          <RowAction item={item} />
        </VStack>
      </CardContent>
    </Card>
  );
}

function RowAction({ item }: { item: InboxItem }): ReactNode {
  const live = useAnswerSource() !== null;
  if (isNavigation(item.action)) return null;
  if (!CONSOLE_TAPS.has(item.action.kind)) return <TerminalAction item={item} reason={laterReason(item.action)} />;
  return live ? <ConsoleAction item={item} /> : <TerminalAction item={item} reason="This page is a snapshot: act from the live console, or run it on the terminal." />;
}

const laterReason = (action: InboxAction): string => (action.kind === "terminal" ? action.reason : `${VERB[action.kind]} from the console comes later; run it on the terminal for now.`);

/** One primary button labelled with the verb; the sheet it opens holds the second tap. */
function ConsoleAction({ item }: { item: InboxItem }): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const command = terminalCommandOf(item);
  const verb = VERB[item.action.kind];
  return (
    <HStack gap={2} align="center" wrap>
      <Button size="sm" onPress={() => setConfirming(true)} testID={`inbox-act-${item.id}`}>
        <ButtonText>{verb}</ButtonText>
      </Button>
      {command !== undefined && canCopy() ? <CopyButton command={command} /> : null}
      {confirming ? <InboxConfirm itemId={item.id} verb={verb} command={command} onClose={() => setConfirming(false)} /> : null}
    </HStack>
  );
}

/** An evidence ref is a console route, a URL, an absolute path or a `$ command`; only the first two can open. */
function EvidenceLink({ evidence }: { evidence: string }): ReactNode {
  if (!/^(#|https?:\/\/)/.test(evidence)) return <Typography variant="mono">{evidence}</Typography>;
  return (
    <Link color="primary" onPress={() => followEvidence(evidence)}>
      {evidence.startsWith("#") ? "Open evidence" : evidence}
    </Link>
  );
}

function TerminalAction({ item, reason }: { item: InboxItem; reason: string }): ReactNode {
  const [shown, setShown] = useState(false);
  const command = terminalCommandOf(item);
  return (
    <VStack gap={2}>
      <HStack gap={2} align="center" wrap>
        <Button variant="outline" size="sm" onPress={() => setShown(!shown)} testID={`inbox-terminal-${item.id}`}>
          <ButtonText>Run on terminal</ButtonText>
        </Button>
        {command !== undefined && canCopy() ? <CopyButton command={command} /> : null}
      </HStack>
      {shown ? <TerminalDetail command={command} reason={reason} /> : null}
    </VStack>
  );
}

function TerminalDetail({ command, reason }: { command: string | undefined; reason: string }): ReactNode {
  return (
    <VStack gap={1}>
      {command !== undefined ? <Typography variant="mono">{command}</Typography> : null}
      <Typography variant="caption" color="secondary">{reason}</Typography>
    </VStack>
  );
}

/** A page served over plain http on the LAN is not a secure context, so it has no clipboard; the command still shows. */
export const canCopy = (): boolean => "clipboard" in navigator;

export function CopyButton({ command }: { command: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
  };
  return (
    <Button variant="ghost" size="sm" onPress={() => void copy()}>
      <ButtonText>{copied ? "Copied" : "Copy command"}</ButtonText>
    </Button>
  );
}
