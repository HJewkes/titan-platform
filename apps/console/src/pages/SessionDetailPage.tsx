import { useState, type ReactNode } from "react";
import {
  Alert,
  BreadcrumbItem,
  Breadcrumbs,
  Card,
  CardContent,
  DataRow,
  DateTime,
  Spinner,
  Tab,
  TabList,
  Tabs,
  Typography,
  VStack,
} from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { open } from "../router.js";
import { ConversationTurns, TouchedFiles, type Timeline } from "./SessionTurns.js";
import { GRAPH_STATE, NoneText, RefLinks, formatCost, formatDuration, formatTokens, spanMs, usageTokens, type SessionRow } from "./SessionFormat.js";

type TimelineResult = ConsoleCommands["sessions.timeline"]["result"];
type TimelineOk = Extract<TimelineResult, { status: "ok" }>;

/** `EXIT.NOINPUT`, which `sessions.timeline` raises for an id in neither the graph nor a transcript root. */
const NOT_FOUND = 66;

const TRANSCRIPT_GONE = "This session's transcript is gone. Turn counts and tokens come from the session graph; message text is unavailable.";
const NOT_INDEXED = "This session is not in the session graph yet, so its agent, task and cost links are missing. The conversation is read from the transcript.";

/** One session: a header of facts, then its conversation and the files it touched. */
export function SessionDetailPage({ sessionId, query }: { sessionId: string; query: string | undefined }): ReactNode {
  const result = useQuery("sessions.timeline", { sessionId });
  if (result.status === "loading") return <Spinner size="sm" label="Loading session" />;
  const body = result.data === undefined ? <LoadFailure sessionId={sessionId} code={result.error?.code} message={result.error?.message} /> : <Loaded result={result.data} query={query} />;
  return (
    <VStack gap={4}>
      <Trail sessionId={sessionId} />
      {body}
    </VStack>
  );
}

function LoadFailure({ sessionId, code, message }: { sessionId: string; code: number | undefined; message: string | undefined }): ReactNode {
  if (code === NOT_FOUND) return <Alert status="warning" message={`No session ${sessionId} in the session graph or on disk.`} />;
  return <Alert status="error" message={`Could not load session ${sessionId}: ${message ?? "no answer"}`} />;
}

function Loaded({ result, query }: { result: TimelineResult; query: string | undefined }): ReactNode {
  if (result.status === "degraded") {
    const { reason, detail } = result.degraded;
    if (reason === "transcript-missing") return <Degraded session={result.session} sessionId={result.sessionId} message={TRANSCRIPT_GONE} />;
    return <Degraded session={null} sessionId={result.sessionId} message={`The session graph is ${GRAPH_STATE[reason]}, and no transcript for this session is on disk. ${detail}`} />;
  }
  const openTurn = Number(new URLSearchParams(query ?? "").get("turn") ?? 0);
  return (
    <VStack gap={4}>
      <Header session={result.session} sessionId={result.sessionId} timeline={result.timeline} />
      {result.source === "filesystem" ? <Alert status="info" message={NOT_INDEXED} /> : null}
      <Records result={result} openTurn={Number.isInteger(openTurn) ? openTurn : 0} />
    </VStack>
  );
}

function Degraded({ session, sessionId, message }: { session: SessionRow | null; sessionId: string; message: string }): ReactNode {
  return (
    <VStack gap={4}>
      <Header session={session} sessionId={sessionId} timeline={null} />
      <Alert status="warning" message={message} />
    </VStack>
  );
}

function Trail({ sessionId }: { sessionId: string }): ReactNode {
  return (
    <Breadcrumbs>
      <BreadcrumbItem onPress={() => open({ view: "sessions" })}>Sessions</BreadcrumbItem>
      <BreadcrumbItem isCurrentPage>{sessionId}</BreadcrumbItem>
    </Breadcrumbs>
  );
}

interface Facts {
  started: string | number | null;
  durationMs: number | null;
  models: string[];
  tokens: number | null;
  costUsd: number | null;
}

/** The graph's rollups when it holds the session; else what the transcript's own timeline counted. */
function factsOf(session: SessionRow | null, timeline: Timeline | null): Facts {
  if (session) {
    return {
      started: session.startedAt,
      durationMs: timeline?.durationMs ?? spanMs(session.startedAt, session.endedAt),
      models: session.usage.map((usage) => usage.model),
      tokens: usageTokens(session),
      costUsd: session.costUsd,
    };
  }
  if (timeline === null) return { started: null, durationMs: null, models: [], tokens: null, costUsd: null };
  const { tokens } = timeline.totals;
  return {
    started: timeline.startMs,
    durationMs: timeline.durationMs,
    models: timeline.tokens.models.map((entry) => entry.model),
    tokens: tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output,
    costUsd: timeline.totals.costUsd,
  };
}

function Header({ session, sessionId, timeline }: { session: SessionRow | null; sessionId: string; timeline: Timeline | null }): ReactNode {
  const facts = factsOf(session, timeline);
  return (
    <Card>
      <CardContent>
        <VStack gap={2}>
          <Typography variant="h4">{session?.title ?? sessionId}</Typography>
          <DataRow label="Agent" value={<RefLinks refs={session?.agentName ? [`agent:${session.agentName}`] : []} />} />
          <DataRow label="Tasks" value={<RefLinks refs={(session?.taskIds ?? []).map((id) => `task:${id}`)} />} />
          <DataRow label="Started" value={<DateTime value={facts.started} format="datetime" fallback="unknown" />} />
          <DataRow label="Duration" value={formatDuration(facts.durationMs)} />
          <DataRow label="Model" value={facts.models.length > 0 ? facts.models.join(", ") : <NoneText />} />
          <DataRow label="Tokens" value={facts.tokens === null ? <NoneText /> : formatTokens(facts.tokens)} />
          <DataRow label="Cost" value={facts.costUsd === null ? <NoneText /> : formatCost(facts.costUsd)} />
          <DataRow label="Branch" value={session?.gitBranch ?? <NoneText />} />
          <DataRow label="PR" value={<RefLinks refs={session?.prs ?? []} />} />
        </VStack>
      </CardContent>
    </Card>
  );
}

/** The panel sits outside `Tabs`, as on the initiative page: `TabPanels` in an auto-height card gets half its content's room. */
function Records({ result, openTurn }: { result: TimelineOk; openTurn: number }): ReactNode {
  const [tab, setTab] = useState(0);
  const labels = [`Conversation (${result.timeline.turns.length})`, `Files (${result.touchedFiles.length})`];
  return (
    <VStack gap={4}>
      <Tabs index={tab} onChange={setTab}>
        <TabList>
          {labels.map((label) => (
            <Tab key={label}>{label}</Tab>
          ))}
        </TabList>
      </Tabs>
      {tab === 0 ? <ConversationTurns turns={result.timeline.turns} openTurn={openTurn} /> : <TouchedFiles files={result.touchedFiles} touches={result.timeline.files.touches} />}
    </VStack>
  );
}
