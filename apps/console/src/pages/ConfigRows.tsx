import type { ReactNode } from "react";
import { Badge, BadgeText, Card, CardContent, HStack, Pill, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { canCopy, CopyButton } from "./InboxPage.js";

export type ConfigRow = ConsoleCommands["config.surfaces"]["result"]["rows"][number];
export type DuplicateRow = ConsoleCommands["config.drift"]["result"]["rows"][number];

type EditState = { kind: "terminal"; command: string; reason: string } | { kind: "read-only"; reason: string };

/** Single quotes keep a path with spaces one word; a quote inside the path closes, escapes and reopens. */
const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/** The command that opens the row's own line, so the owner edits exactly the line the page shows. */
const editCommandOf = (row: Pick<ConfigRow, "file" | "line">): string => `"\${EDITOR:-vi}" +${row.line} ${shellQuote(row.file)}`;

/** The console takes no config write yet (TP-3579 W slices), so every line a person can edit is a terminal row. */
function editStateOf(row: ConfigRow): EditState {
  if (row.hidden) return { kind: "read-only", reason: "A secret or undeclared key: the console never reads its value." };
  if (row.surface === "console-env") return { kind: "read-only", reason: "Set in the console daemon's environment; a change applies at its next restart." };
  if (row.line === 0) return { kind: "read-only", reason: "Derived from the whole file, so no one line holds it." };
  const reason = row.surface.startsWith("claude-settings")
    ? "Claude Code settings are rendered by chezmoi: make the same change in its template, or the next apply undoes it."
    : "The console does not edit config yet; change this line in a terminal.";
  return { kind: "terminal", command: editCommandOf(row), reason };
}

function formatValue(value: unknown): string {
  if (value === undefined) return "unset";
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => item === null || typeof item !== "object")) return value.map(String).join(", ");
  return JSON.stringify(value);
}

/** A hidden row names its key and nothing else; its value is never rendered, even if a reply carried one. */
function RowValue({ row }: { row: ConfigRow }): ReactNode {
  if (row.hidden) return <Typography variant="body2" color="secondary" testID="config-row-present">present</Typography>;
  return <Typography variant="mono" className="break-all">{formatValue(row.value)}</Typography>;
}

export function ConfigRowCard({ row }: { row: ConfigRow }): ReactNode {
  const state = editStateOf(row);
  return (
    <Card variant="outline" testID={`config-row-${row.surface}-${row.field}`}>
      <CardContent>
        <VStack gap={2}>
          <HStack gap={2} align="center" wrap>
            <Typography variant="subtitle2" className="break-all">{row.field}</Typography>
            <Badge color={state.kind === "terminal" ? "primary" : "default"} variant="subtle" size="sm">
              <BadgeText>{state.kind}</BadgeText>
            </Badge>
          </HStack>
          <RowValue row={row} />
          <RowProvenance row={row} />
          <RowEdit state={state} />
        </VStack>
      </CardContent>
    </Card>
  );
}

function RowProvenance({ row }: { row: ConfigRow }): ReactNode {
  return (
    <HStack gap={2} align="center" wrap>
      <Typography variant="caption" color="secondary" className="break-all">{row.line > 0 ? `${row.file}:${row.line}` : row.file}</Typography>
      {row.comment !== undefined ? <Typography variant="caption" color="secondary">{row.comment}</Typography> : null}
      {row.decisions.map((decision) => (
        <Pill key={decision} variant="subtle" size="xs">{`decision ${decision}`}</Pill>
      ))}
    </HStack>
  );
}

function RowEdit({ state }: { state: EditState }): ReactNode {
  if (state.kind === "read-only") return <Typography variant="caption" color="secondary">{state.reason}</Typography>;
  return (
    <VStack gap={1}>
      <HStack gap={2} align="center" wrap>
        <Typography variant="mono" className="break-all" testID="config-row-command">{state.command}</Typography>
        {canCopy() ? <CopyButton command={state.command} /> : null}
      </HStack>
      <Typography variant="caption" color="secondary">{state.reason}</Typography>
    </VStack>
  );
}

export function DuplicateCard({ row }: { row: DuplicateRow }): ReactNode {
  return (
    <Card variant="outline" testID={`config-duplicate-${row.id}`}>
      <CardContent>
        <VStack gap={2}>
          <HStack gap={2} align="center" wrap>
            <Typography variant="subtitle2">{row.label}</Typography>
            <Badge color={row.status === "drift" ? "warning" : "default"} variant="subtle" size="sm">
              <BadgeText>{row.status}</BadgeText>
            </Badge>
          </HStack>
          {row.sources.map((source) => (
            <VStack key={`${source.surface}:${source.field}`} gap={0}>
              <Typography variant="mono" className="break-all">{`${source.surface} ${source.field} = ${formatValue(source.value)}`}</Typography>
              <Typography variant="caption" color="secondary" className="break-all">{`${source.file}:${source.line}`}</Typography>
            </VStack>
          ))}
          {row.absent.length > 0 ? (
            <Typography variant="caption" color="secondary">{`Not on this host or hidden: ${row.absent.map((copy) => `${copy.surface} ${copy.field}`).join(", ")}`}</Typography>
          ) : null}
        </VStack>
      </CardContent>
    </Card>
  );
}
