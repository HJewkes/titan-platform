import { useState, type ReactNode } from "react";
import { Alert, Badge, BadgeText, Button, ButtonText, Card, CardContent, EmptyState, HStack, Link, Pill, Section, SectionContent, SectionHeader, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import type { MergeWait } from "../../server/inbox-op.js";
import { useQuery } from "../data/rpc.js";
import { useAnswerSource } from "../data/submit.js";
import { open, parseRoute, type Route } from "../router.js";
import { GateStripView } from "./GateStrip.js";
import { openExternal } from "./homeLinks.js";
import { FocusBadge, FocusNotice, FocusTarget, holdsFocus, InboxFocusProvider, useIsFocused } from "./InboxFocus.js";
import { NudgeSection } from "./InboxNudges.js";
import { InboxReadBack, type InboxReady } from "./InboxReadBack.js";
import { TapSheet, type TapCommands, type TapConfirmChoice } from "./TapSheet.js";

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
  "owner-op": "Confirm",
  "answer-chat": "Answer",
  "approve-chat": "Approve",
  "open-round": "Open round",
  open: "Open",
  terminal: "Run on terminal",
};

const OP_VERB: Partial<Record<Extract<InboxAction, { kind: "owner-op" }>["op"]["kind"], string>> = { "merge-at-head": "Merge at head", "retire-agent": "Retire", "close-pr": "Close PR", "deploy-pause-clear": "Clear deploy pause" };

type GateDecision = Extract<InboxAction, { kind: "resolve-gate" }>["decision"];

/** A sent-back tap waits for the implementer's next head or waives this head's fix-proof, so it never reads as a merge. */
const GATE_VERB: Record<GateDecision, string> = { merge: VERB["resolve-gate"], "await-new-head": "Wait for new head", "waive-proof": "Waive fix-proof" };

/** On a g10-held PR the plain merge goes past the hold, so its verb says which verdicts it skips. */
const PAST_HOLD_VERB: Readonly<Record<string, string>> = { "g10-adversary": "Merge without both MERGEs", "g10-review": "Merge without a MERGE" };
const AFTER_LOOP_VERB = "Approve; merge when the loop closes";

/** The forced merge's verb on a g10-held merge-at-head; any other item has none, and keeps its single tap. */
const pastHoldVerb = (item: InboxItem): string | undefined =>
  item.action.kind === "owner-op" && item.action.op.kind === "merge-at-head" && item.hold !== undefined ? PAST_HOLD_VERB[item.hold.class] : undefined;

function verbOf(action: InboxAction): string {
  if (action.kind === "owner-op") return OP_VERB[action.op.kind] ?? VERB[action.kind];
  return action.kind === "resolve-gate" ? GATE_VERB[action.decision] : VERB[action.kind];
}

/** Navigation stays a link; a write the console does not take yet is shown as its terminal command. */
const isNavigation = (action: InboxAction): boolean => action.kind === "open" || action.kind === "open-round";

/** The writes the page taps through `inbox.act`; `answer-chat` waits on a sheet that takes the answer's text. */
const CONSOLE_TAPS: ReadonlySet<InboxAction["kind"]> = new Set(["resolve-gate", "owner-release", "owner-op", "approve-chat"]);

/** A permission prompt is answered Allow or Deny and an endorsement Endorse; the verdict goes to the act alone, never with text. */
function verdictChoicesOf({ readBack }: InboxReady): readonly TapConfirmChoice[] {
  if (!("kind" in readBack)) return [];
  if (readBack.kind === "endorse") return [{ id: "endorse", label: "Endorse", color: "success", args: { verdict: "endorse" } }];
  return [
    { id: "allow", label: "Allow", color: "success", args: { verdict: "allow" } },
    { id: "deny", label: "Deny", color: "error", args: { verdict: "deny" } },
  ];
}

const readingOf = (action: InboxAction): string => (action.kind === "approve-chat" ? "Reading the agent's prompt from the broker" : "Reading the live gate and head");

function followEvidence(evidence: string): void {
  if (evidence.startsWith("#")) open(parseRoute(evidence));
  else openExternal(evidence);
}

/** Every pending owner decision in one list: blocking first, then planning collapsed, then a count of FYIs; `#/inbox/<id>` focuses one item. */
export function InboxPage({ route }: { route?: Route }): ReactNode {
  const inbox = useQuery("inbox.list");
  if (inbox.status === "loading") return <Spinner size="sm" label="Loading the inbox" />;
  if (inbox.data === undefined) return <Alert status="error" message={`Could not load the inbox: ${inbox.error.message}`} />;
  // A snapshot exported before TP-4044 carries no nudges.
  const { items, gaps, fyiCount, derived, nudges = [] } = inbox.data;
  const blocking = items.filter((item) => item.section === "blocking");
  const planning = items.filter((item) => item.section === "planning");
  return (
    <InboxFocusProvider value={route?.id}>
      <VStack gap={6}>
        <FocusNotice items={items} focusId={route?.id} gapped={gaps.length > 0} />
        <GapBanners gaps={gaps} />
        {nudges.length > 0 ? <NudgeSection nudges={nudges} /> : null}
        <BlockingSection items={blocking} quiet={planning.length === 0 && derived.length === 0 && nudges.length === 0} gapped={gaps.length > 0} />
        {derived.length > 0 ? <DerivedSection rows={derived} /> : null}
        {planning.length > 0 ? <PlanningSection items={planning} startOpen={holdsFocus(planning, route?.id)} /> : null}
        <Typography variant="caption" color="secondary" testID="inbox-fyi">{`FYI: ${fyiCount}`}</Typography>
      </VStack>
    </InboxFocusProvider>
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
      <SectionContent>{items.length === 0 ? empty : <BlockingRows items={items} />}</SectionContent>
    </Section>
  );
}

/** Aged blockers still block, so they stay open on the page, listed after the fresh ones under their own heading. */
function BlockingRows({ items }: { items: readonly InboxItem[] }): ReactNode {
  const aged = items.filter((item) => item.aged === true);
  const fresh = items.filter((item) => item.aged !== true);
  return (
    <VStack gap={4}>
      {fresh.length > 0 ? <InboxRows items={fresh} /> : null}
      {aged.length > 0 ? (
        <VStack gap={3} testID="inbox-blocking-aged">
          <Typography variant="subtitle2" color="secondary">{`Older than 4 days (${aged.length})`}</Typography>
          <InboxRows items={aged} />
        </VStack>
      ) : null}
    </VStack>
  );
}

const DERIVED_LABEL: Record<DerivedRow["kind"], string> = { "stalled-run": "stalled", "failed-run": "failed", "blocked-agent": "blocked", "missed-notice": "notice failed" };
const DERIVED_LINK: Record<DerivedRow["kind"], string> = { "stalled-run": "Open the run", "failed-run": "Open the run", "blocked-agent": "Open the agent", "missed-notice": "Open the round" };

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
            {DERIVED_LINK[row.kind]}
          </Link>
        </VStack>
      </CardContent>
    </Card>
  );
}

/** Planning can run to hundreds of rows, so it opens only when asked, or when a link names one of them. */
function PlanningSection({ items, startOpen }: { items: readonly InboxItem[]; startOpen: boolean }): ReactNode {
  const [isOpen, setOpen] = useState(startOpen);
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
        <FocusTarget key={item.id} itemId={item.id}>
          <InboxRow item={item} />
        </FocusTarget>
      ))}
    </VStack>
  );
}

function InboxRow({ item }: { item: InboxItem }): ReactNode {
  const badge = badgeOf(item);
  const recommendation = recommendationOf(item);
  const focused = useIsFocused(item.id);
  return (
    <Card variant={focused ? "accent" : "outline"} testID={`inbox-row-${item.id}`}>
      <CardContent>
        <VStack gap={2}>
          <Typography variant="subtitle2">{item.summary}</Typography>
          <HStack gap={2} align="center" wrap>
            {focused ? <FocusBadge /> : null}
            <Badge color={badge.color} variant="subtle" size="sm">
              <BadgeText>{badge.label}</BadgeText>
            </Badge>
            <Typography variant="caption" color="secondary">{ageOf(item.openedAt)}</Typography>
            {item.questionCount !== undefined ? <Pill variant="subtle" size="xs">{`${item.questionCount} questions`}</Pill> : null}
            {recommendation !== undefined ? <Pill variant="subtle" size="xs">{`Recommend: ${recommendation}`}</Pill> : null}
            {item.hold !== undefined ? <Typography variant="caption" color="secondary">{item.hold.reason}</Typography> : null}
          </HStack>
          {item.evidence !== undefined ? <EvidenceLink evidence={item.evidence} /> : null}
          {item.gates !== undefined ? <GateStripView strip={item.gates} /> : null}
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
  if (!live) return <TerminalAction item={item} reason="This page is a snapshot: act from the live console, or run it on the terminal." />;
  const forced = pastHoldVerb(item);
  return forced === undefined ? <GateActions item={item} /> : <HeldMergeActions item={item} forced={forced} />;
}

/** A g10-held merge offers both taps: the forced merge past the hold, and the approval that leaves the merge to the adversary loop. */
function HeldMergeActions({ item, forced }: { item: InboxItem; forced: string }): ReactNode {
  return (
    <HStack gap={2} align="center" wrap>
      <ConsoleAction item={item} verb={forced} />
      <ConsoleAction item={item} verb={AFTER_LOOP_VERB} choice={{ waitFor: "adversary-loop" }} />
    </HStack>
  );
}

const laterReason = (action: InboxAction): string => (action.kind === "terminal" ? action.reason : `${verbOf(action)} from the console comes later; run it on the terminal for now.`);

interface TapChoice {
  decision?: GateDecision;
  waitFor?: MergeWait;
}

const inboxTap = (itemId: string, { decision, waitFor }: TapChoice): TapCommands => ({ prepare: "inbox.prepare", act: "inbox.act", args: { itemId, ...(decision && { decision }), ...(waitFor && { waitFor }) }, invalidates: ["inbox.list"] });

const alternativesOf = (action: InboxAction): readonly GateDecision[] => (action.kind === "resolve-gate" ? (action.alternatives ?? []) : []);

/** The item's own tap, and an outline one per second decision its gate offers, never styled as the recommendation. */
function GateActions({ item }: { item: InboxItem }): ReactNode {
  const alternatives = alternativesOf(item.action);
  if (alternatives.length === 0) return <ConsoleAction item={item} verb={verbOf(item.action)} />;
  return (
    <HStack gap={2} align="center" wrap>
      <ConsoleAction item={item} verb={verbOf(item.action)} />
      {alternatives.map((decision) => (
        <ConsoleAction key={decision} item={item} verb={GATE_VERB[decision]} choice={{ decision }} />
      ))}
    </HStack>
  );
}

/** One button labelled with the verb, primary for the item's own tap; the sheet it opens holds the confirming tap. */
function ConsoleAction({ item, verb, choice = {} }: { item: InboxItem; verb: string; choice?: TapChoice }): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const command = terminalCommandOf(item);
  const suffix = choice.decision ?? choice.waitFor;
  return (
    <HStack gap={2} align="center" wrap>
      <Button {...(choice.decision !== undefined && { variant: "outline" as const })} size="sm" onPress={() => setConfirming(true)} testID={`inbox-act-${item.id}${suffix === undefined ? "" : `-${suffix}`}`}>
        <ButtonText>{verb}</ButtonText>
      </Button>
      {command !== undefined && canCopy() && suffix === undefined ? <CopyButton command={command} /> : null}
      {confirming ? (
        <TapSheet<InboxReady> commands={inboxTap(item.id, choice)} verb={verb} reading={readingOf(item.action)} command={command} renderReadBack={(prepared) => <InboxReadBack prepared={prepared} />} choicesOf={verdictChoicesOf} testID="inbox-confirm" onClose={() => setConfirming(false)} />
      ) : null}
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
