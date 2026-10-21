import type { ReactNode } from "react";
import { Card, CardContent, Input, Typography, VStack } from "@titan-design/react-ui";
import type { Question } from "../../server/round-schema.js";
import { RoundProse } from "./RoundMarkdown.js";

type PickQuestion = Extract<Question, { kind: "pick-one" | "pick-many" }>;
export type OptionDetail = NonNullable<PickQuestion["optionDetails"]>[string];

/** What a page that takes option notes holds for one question: a note per option, by option text. */
export interface OptionNoting {
  notes: Readonly<Record<string, string>>;
  onNote: (option: string, text: string) => void;
  /** The round is sent: each note box gives way to the note as sent. */
  sent?: boolean;
}

/** A decision packet's options draw as cards: a pick-one or pick-many that says what each option means (G16). */
export const hasOptionCards = (question: Question): question is PickQuestion =>
  (question.kind === "pick-one" || question.kind === "pick-many") && question.optionDetails !== undefined;

/** An option's packet texts in the harness's order; they show whether or not the recommendation does. */
export function OptionTexts({ option, detail }: { option: string; detail: OptionDetail }): ReactNode {
  return (
    <VStack gap={2} testID={`option-detail-${option}`}>
      <RoundProse text={detail.detail} />
      {detail.weakPoint ? <Tagged tag="Weak point" text={detail.weakPoint} /> : null}
      {detail.after ? <Tagged tag="If you pick this" text={detail.after} /> : null}
    </VStack>
  );
}

function Tagged({ tag, text }: { tag: string; text: string }): ReactNode {
  return (
    <VStack gap={0}>
      <Typography variant="microLabel" color="secondary">{tag.toUpperCase()}</Typography>
      <RoundProse text={text} />
    </VStack>
  );
}

interface OptionCardProps {
  option: string;
  detail: OptionDetail | undefined;
  picked: boolean;
  /** Present where the page takes option notes. */
  noting?: OptionNoting;
  /** The option's radio or checkbox, so a card picks exactly as a plain option does. */
  children: ReactNode;
}

/** One option as a card: its pick, what picking it means, and a note on it. */
export function OptionCard({ option, detail, picked, noting, children }: OptionCardProps): ReactNode {
  return (
    <Card variant={picked ? "outline" : "subtle"} testID={`option-card-${option}`}>
      <CardContent>
        <VStack gap={2}>
          {children}
          {detail ? <OptionTexts option={option} detail={detail} /> : null}
          {noting ? <OptionNote option={option} label="Note on this option (optional)" {...noting} /> : null}
        </VStack>
      </CardContent>
    </Card>
  );
}

/** An option's note box, or the note as sent once the round is. */
export function OptionNote({ option, label, notes, onNote, sent }: OptionNoting & { option: string; label: string }): ReactNode {
  if (sent) return <SentNote option={option} note={notes[option]} />;
  return <Input multiline numberOfLines={2} label={label} accessibilityLabel={`Note on ${option}`} value={notes[option] ?? ""} onChangeText={(text) => onNote(option, text)} />;
}

function SentNote({ option, note }: { option: string; note: string | undefined }): ReactNode {
  if (!note?.trim()) return null;
  return (
    <VStack gap={1} testID={`option-note-sent-${option}`}>
      <Typography variant="microLabel" color="secondary">YOUR NOTE</Typography>
      <Typography variant="body2">{note}</Typography>
    </VStack>
  );
}
