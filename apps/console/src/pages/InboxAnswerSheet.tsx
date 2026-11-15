import { useState, type ReactNode } from "react";
import { Button, ButtonText, HStack, Input, Typography, VStack } from "@titan-design/react-ui";
import { PHONE_TAP } from "./phone.js";
import type { InboxReady } from "./InboxReadBack.js";
import { TapSheet, type TapCommands } from "./TapSheet.js";

type ChatReadBack = Extract<InboxReady["readBack"], { question: string }>;

const isChatReadBack = (readBack: InboxReady["readBack"]): readBack is ChatReadBack => "question" in readBack;

interface AnswerSheetProps {
  commands: TapCommands;
  command: string | undefined;
  onClose: () => void;
}

/** The sheet that answers an agent's chat question: its read-back, the asker's options as chips that fill a text field, and Confirm once there are words. */
export function InboxAnswerSheet({ commands, command, onClose }: AnswerSheetProps): ReactNode {
  const [text, setText] = useState("");
  return (
    <TapSheet<InboxReady>
      commands={commands}
      verb="Answer"
      reading="Reading the agent's question from the broker"
      command={command}
      renderReadBack={(prepared) => <AnswerReadBack prepared={prepared} text={text} onText={setText} />}
      confirmArgs={{ text }}
      confirmDisabled={text.trim() === ""}
      testID="inbox-confirm"
      onClose={onClose}
    />
  );
}

interface AnswerReadBackProps {
  prepared: InboxReady;
  text: string;
  onText: (text: string) => void;
}

function AnswerReadBack({ prepared, text, onText }: AnswerReadBackProps): ReactNode {
  const { readBack } = prepared;
  if (!isChatReadBack(readBack)) return null;
  return (
    <VStack gap={2} testID="inbox-readback">
      <Typography variant="subtitle1">{readBack.title}</Typography>
      {readBack.asker === undefined ? null : <Typography variant="caption" color="secondary">{`Asked by ${readBack.asker}`}</Typography>}
      <Typography variant="body2">{readBack.question}</Typography>
      <Chips readBack={readBack} onPick={onText} />
      <Input multiline numberOfLines={3} accessibilityLabel="Your answer" value={text} onChangeText={onText} />
    </VStack>
  );
}

function Chips({ readBack, onPick }: { readBack: ChatReadBack; onPick: (text: string) => void }): ReactNode {
  if (readBack.options === undefined || readBack.options.length === 0) return null;
  return (
    <HStack gap={2} align="center" wrap>
      {readBack.options.map((option) => (
        <Button key={option.id} variant="outline" size="sm" className={PHONE_TAP} onPress={() => onPick(option.label)} testID={`inbox-confirm-chip-${option.id}`}>
          <ButtonText>{option.id === readBack.recommended ? `${option.label} (recommended)` : option.label}</ButtonText>
        </Button>
      ))}
    </HStack>
  );
}
