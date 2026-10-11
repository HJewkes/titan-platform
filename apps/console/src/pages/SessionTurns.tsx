import type { ReactNode } from "react";
import {
  Collapse,
  CollapseButton,
  CollapseContent,
  DataRow,
  DateTime,
  FilePathLabel,
  HStack,
  MarkdownProse,
  Pill,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Typography,
  VStack,
} from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { ExternalLink } from "./SessionFormat.js";

type TimelineOk = Extract<ConsoleCommands["sessions.timeline"]["result"], { status: "ok" }>;
export type Timeline = TimelineOk["timeline"];
type Turn = Timeline["turns"][number];
type Message = NonNullable<Turn["user"]>;
type ToolCall = Turn["toolCalls"][number];
type TouchedFile = TimelineOk["touchedFiles"][number];
type Touch = Timeline["files"]["touches"][number];

const OPENER: Record<Turn["origin"], string> = { prompt: "User", injected: "Harness", compaction: "Compaction summary", none: "User" };

/**
 * The Conversation tab until react-ui releases `SessionConversation` (TP-855): one collapsible
 * block per turn, its messages and tool calls in source order.
 */
export function ConversationTurns({ turns, openTurn }: { turns: readonly Turn[]; openTurn: number }): ReactNode {
  if (turns.length === 0) {
    return (
      <VStack gap={1}>
        <Typography variant="subtitle1">No turns</Typography>
        <Typography variant="caption" color="secondary">
          This session has no messages or tool calls yet.
        </Typography>
      </VStack>
    );
  }
  return (
    <VStack gap={2}>
      {turns.map((turn) => (
        <TurnBlock key={turn.index} turn={turn} isOpen={turn.index === openTurn} />
      ))}
    </VStack>
  );
}

function TurnBlock({ turn, isOpen }: { turn: Turn; isOpen: boolean }): ReactNode {
  const calls = turn.toolCalls.length;
  return (
    <Collapse defaultIsOpen={isOpen} testID={`turn-${turn.index}`}>
      <CollapseButton>
        <HStack gap={2} align="center">
          <Typography variant="boldLabel">{`Turn ${turn.index + 1}`}</Typography>
          <DateTime value={turn.startMs} format="time" variant="caption" color="secondary" fallback="" />
          <Typography variant="caption" color="secondary">{`${calls} tool ${calls === 1 ? "call" : "calls"}`}</Typography>
          {turn.errorCount > 0 ? <Pill variant="subtle" size="xs">{`${turn.errorCount} failed`}</Pill> : null}
        </HStack>
      </CollapseButton>
      <CollapseContent>
        <VStack gap={2}>
          {entriesOf(turn).map((entry) =>
            "role" in entry ? <MessageBlock key={`m${entry.seq}`} message={entry} opener={OPENER[turn.origin]} /> : <ToolCallRow key={entry.id} call={entry} />,
          )}
        </VStack>
      </CollapseContent>
    </Collapse>
  );
}

function entriesOf(turn: Turn): (Message | ToolCall)[] {
  const messages = turn.user ? [turn.user, ...turn.assistant] : turn.assistant;
  return [...messages, ...turn.toolCalls].sort((a, b) => a.seq - b.seq);
}

function MessageBlock({ message, opener }: { message: Message; opener: string }): ReactNode {
  return (
    <VStack gap={1}>
      <Typography variant="microLabel" color="secondary">
        {message.role === "user" ? opener : "Assistant"}
      </Typography>
      <MarkdownProse body={message.text} />
      {message.truncated ? (
        <Typography variant="caption" color="secondary">
          Cut at the read cap.
        </Typography>
      ) : null}
    </VStack>
  );
}

function ToolCallRow({ call }: { call: ToolCall }): ReactNode {
  const outcome = call.outcome === "error" ? ` (failed: ${call.errorMessage ?? "no message"})` : "";
  return <DataRow label={call.name} value={`${call.inputSummary}${outcome}`} />;
}

/** Each touched path, linked to its codewatch node when the server could map it to one (TP-1065). */
export function TouchedFiles({ files, touches }: { files: readonly TouchedFile[]; touches: readonly Touch[] }): ReactNode {
  if (files.length === 0) {
    return (
      <Typography variant="caption" color="secondary">
        No files touched.
      </Typography>
    );
  }
  return (
    <Table density="dense">
      <TableHeader>
        <TableRow>
          <TableHeaderCell>File</TableHeaderCell>
          <TableHeaderCell width={160}>Access</TableHeaderCell>
          <TableHeaderCell width={96} align="right">
            Calls
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.map((file) => (
          <TouchedFileRow key={file.touchPath} file={file} touches={touches.filter((touch) => touch.path === file.touchPath)} />
        ))}
      </TableBody>
    </Table>
  );
}

function TouchedFileRow({ file, touches }: { file: TouchedFile; touches: readonly Touch[] }): ReactNode {
  return (
    <TableRow testID={`touched-${file.path}`}>
      <TableCell>
        {file.href ? <ExternalLink url={file.href}>{file.path}</ExternalLink> : <FilePathLabel path={file.path} size="sm" />}
      </TableCell>
      <TableCell width={160}>
        <HStack gap={1}>
          {touches.map((touch) => (
            <Pill key={touch.access} variant="subtle" size="xs">
              {touch.access}
            </Pill>
          ))}
        </HStack>
      </TableCell>
      <TableCell width={96} align="right">
        {String(touches.reduce((sum, touch) => sum + touch.calls, 0))}
      </TableCell>
    </TableRow>
  );
}
