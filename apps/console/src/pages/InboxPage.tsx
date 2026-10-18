import { useState, type ReactNode } from "react";
import { Alert, Badge, BadgeText, Button, ButtonText, Card, CardContent, EmptyState, HStack, Link, Pill, Section, SectionContent, SectionHeader, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { open, parseRoute } from "../router.js";
import { openExternal } from "./homeLinks.js";

export type InboxItem = ConsoleCommands["inbox.list"]["result"]["items"][number];
type InboxAction = InboxItem["action"];

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
export function terminalCommandOf(item: InboxItem, action: InboxAction = item.action): string | undefined {
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

/** Navigation stays a link; a write is shown as its terminal command until the console takes it itself (S6). */
const isNavigation = (action: InboxAction): boolean => action.kind === "open" || action.kind === "open-round";

function followEvidence(evidence: string): void {
  if (evidence.startsWith("#")) open(parseRoute(evidence));
  else openExternal(evidence);
}

/** Every pending owner decision in one list: blocking first, then planning collapsed, then a count of FYIs. Read-only. */
export function InboxPage(): ReactNode {
  const inbox = useQuery("inbox.list");
  if (inbox.status === "loading") return <Spinner size="sm" label="Loading the inbox" />;
  if (inbox.data === undefined) return <Alert status="error" message={`Could not load the inbox: ${inbox.error.message}`} />;
  const { items, gaps, fyiCount } = inbox.data;
  const blocking = items.filter((item) => item.section === "blocking");
  const planning = items.filter((item) => item.section === "planning");
  return (
    <VStack gap={6}>
      <GapBanners gaps={gaps} />
      <BlockingSection items={blocking} quiet={planning.length === 0} gapped={gaps.length > 0} />
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
          {isNavigation(item.action) ? null : <TerminalAction item={item} />}
        </VStack>
      </CardContent>
    </Card>
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

function TerminalAction({ item }: { item: InboxItem }): ReactNode {
  const [shown, setShown] = useState(false);
  const command = terminalCommandOf(item);
  const reason = item.action.kind === "terminal" ? item.action.reason : `${VERB[item.action.kind]} from the console comes later; run it on the terminal for now.`;
  return (
    <VStack gap={2}>
      <HStack gap={2} align="center" wrap>
        <Button variant="outline" size="sm" onPress={() => setShown(!shown)} testID={`inbox-terminal-${item.id}`}>
          <ButtonText>Run on terminal</ButtonText>
        </Button>
        {command !== undefined ? <CopyButton command={command} /> : null}
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

function CopyButton({ command }: { command: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    await navigator.clipboard?.writeText(command);
    setCopied(true);
  };
  return (
    <Button variant="ghost" size="sm" onPress={() => void copy()}>
      <ButtonText>{copied ? "Copied" : "Copy command"}</ButtonText>
    </Button>
  );
}
