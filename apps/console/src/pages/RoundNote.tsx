import { type ReactNode } from "react";
import { Typography, VStack } from "@titan-design/react-ui";
import { noteRows } from "./note-rows.js";
import { RoundProse } from "./RoundMarkdown.js";

/** An author's note as reading text: one row per line, each "LABEL:" shown quietly above its value as markdown; `heading` labels the whole note. */
export function RoundNote({ heading, text }: { heading?: string; text: string }): ReactNode {
  return (
    <VStack gap={2}>
      {heading ? <Typography variant="overline" color="secondary">{heading}</Typography> : null}
      {noteRows(text).map((row, index) => (
        <VStack key={index} gap={0} testID="round-note-row">
          {row.label ? <Typography variant="overline" color="secondary">{row.label}</Typography> : null}
          {row.value ? <RoundProse text={row.value} /> : null}
        </VStack>
      ))}
    </VStack>
  );
}
