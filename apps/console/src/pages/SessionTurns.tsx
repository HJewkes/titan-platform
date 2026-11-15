import type { ReactNode } from "react";
import {
  FilePathLabel,
  HStack,
  Pill,
  SessionConversation,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Typography,
} from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { ExternalLink } from "./SessionFormat.js";

type TimelineOk = Extract<ConsoleCommands["sessions.timeline"]["result"], { status: "ok" }>;
export type Timeline = TimelineOk["timeline"];
type TouchedFile = TimelineOk["touchedFiles"][number];
type Touch = Timeline["files"]["touches"][number];

/** The Conversation tab: the timeline's turns as they come, with the deep-linked turn's tool calls open. */
export function ConversationTurns({ turns, openTurn }: { turns: Timeline["turns"]; openTurn: number }): ReactNode {
  return <SessionConversation turns={[...turns]} defaultExpandedTurns={[openTurn]} />;
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
