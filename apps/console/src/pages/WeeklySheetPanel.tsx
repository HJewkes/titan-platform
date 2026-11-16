import type { ReactNode } from "react";
import { Alert, HStack, MarkdownProse, Pill, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import { useQuery } from "../data/rpc.js";
import { Spinner } from "../shell/Loading.js";

type Sheet = NonNullable<ConsoleCommands["work.sheet"]["result"]["sheet"]>;

/** The initiative's newest weekly sheet (TP-5453 P16). It only shows the sheet: answering it is not a console action yet. */
export function WeeklySheetPanel({ slug }: { slug: string }): ReactNode {
  const answer = useQuery("work.sheet", { slug });
  if (answer.status === "loading") return <Spinner size="sm" label="Loading weekly sheet" />;
  if (answer.data === undefined) return <Alert status="error" size="compact" message={`Could not load the weekly sheet: ${answer.error.message}`} />;
  const { sheet } = answer.data;
  if (sheet === null) return <Typography variant="caption" color="secondary">No weekly sheet yet</Typography>;
  return <SheetRead sheet={sheet} />;
}

function SheetRead({ sheet }: { sheet: Sheet }): ReactNode {
  const flagged = sheet.flags.length;
  return (
    <VStack gap={3}>
      <HStack gap={2} align="center" wrap>
        <Pill variant="subtle" size="xs">{`Week ${sheet.week}`}</Pill>
        <Pill variant="subtle" size="xs">{sheet.decidedOn === null ? `Open until ${sheet.deadline}` : `Defaults recorded ${sheet.decidedOn}`}</Pill>
      </HStack>
      {flagged > 0 ? <Alert status="warning" size="compact" message={`${flagged} bet ${flagged === 1 ? "line cites" : "lines cite"} no intent line: ${sheet.flags.map((flag) => flag.bet).join(", ")}`} /> : null}
      <MarkdownProse body={sheet.markdown} testID="weekly-sheet-body" />
    </VStack>
  );
}
