import { useEffect, type ReactNode } from "react";
import { HStack, Pill, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";

type EditRow = ConsoleCommands["videos.edits"]["result"]["edits"][number];

/** A run that has not reached one of these is still going, so its row is read again until it does. */
const SETTLED = new Set(["completed", "failed", "cancelled", "unknown", "not started"]);
const POLL_MS = 5_000;

const TONES: Record<string, "success" | "error" | "neutral"> = { completed: "success", failed: "error", cancelled: "neutral" };

function EditLine({ edit }: { edit: EditRow }): ReactNode {
  const beats = Object.keys(edit.beats);
  return (
    <HStack gap={2} align="center" wrap className="max-w-full" testID={`theater-edit-${edit.editId}`}>
      <Typography variant="body2" className="max-w-full break-words">{`${beats.length} beat${beats.length === 1 ? "" : "s"}: ${beats.join(", ")}`}</Typography>
      <Pill variant="subtle" tone={TONES[edit.runStatus] ?? "info"} size="xs" className="max-w-full" testID={`theater-edit-status-${edit.editId}`}>
        {`run ${edit.runStatus}`}
      </Pill>
      {edit.fromNote === undefined ? null : <Typography variant="caption" color="secondary">from a note</Typography>}
    </HStack>
  );
}

/** The saved edits drafted over this render, newest first; a row whose run is still going is read again every few seconds. */
export function TheaterEdits({ videoId }: { videoId: string }): ReactNode {
  const edits = useQuery("videos.edits", { videoId });
  const rows = edits.data?.edits ?? [];
  const going = rows.some((edit) => !SETTLED.has(edit.runStatus));
  const { refetch } = edits;
  useEffect(() => {
    if (!going) return undefined;
    const timer = setInterval(refetch, POLL_MS);
    return () => clearInterval(timer);
  }, [going, refetch]);
  if (rows.length === 0 && (edits.data?.gaps ?? []).length === 0) return null;
  return (
    <VStack gap={1} className="w-full min-w-0" testID="theater-edits">
      <Typography variant="subtitle2">Saved edits</Typography>
      {(edits.data?.gaps ?? []).map((gap) => <Typography key={gap} variant="caption" color="secondary">{`Saved edits: ${gap}`}</Typography>)}
      {[...rows].reverse().map((edit) => <EditLine key={edit.editId} edit={edit} />)}
    </VStack>
  );
}
