import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Button, ButtonText, Card, CardContent, HStack, Heading, Pill, Typography, VStack } from "@titan-design/react-ui";
import type { Manifest } from "../../server/round-schema.js";
import { InlineMarkdown } from "./RoundMarkdown.js";
import { answerText, firstOpen, type CheckFrame, type CheckVerdict, type CheckGroup, type CheckRow } from "./round-check.js";
import { typedInto } from "./typed-into.js";

/**
 * Whether the round shows its check-before-send screen, and the question a step from it lands on. The screen stands in
 * for the round's pages, so the pager draws nothing else while it is open.
 */
export function useSendCheck() {
  const [open, setOpen] = useState(false);
  const [landOn, setLandOn] = useState<string | undefined>();
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const jumpTo = useCallback((questionId: string) => {
    setLandOn(questionId);
    setOpen(false);
  }, []);
  const landed = useCallback(() => setLandOn(undefined), []);
  return { open, show, close, jumpTo, landOn, landed };
}

export type SendCheck = ReturnType<typeof useSendCheck>;

/** Esc goes back to answering and Cmd/Ctrl+Enter sends; no other modified key, and nothing typed into a field, acts. */
function useCheckKeys(back: () => void, send: (() => void) | undefined): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (typedInto(event.target) || event.altKey || event.shiftKey) return;
      const command = event.metaKey || event.ctrlKey;
      const act = event.key === "Escape" && !command ? back : event.key === "Enter" && command ? send : undefined;
      if (act === undefined) return;
      event.preventDefault();
      act();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back, send]);
}

interface RoundCheckProps {
  manifest: Manifest;
  groups: CheckGroup[];
  general: string;
  check: SendCheck;
  /** Absent while a send is in flight or the page cannot send, so neither the button nor Cmd/Ctrl+Enter sends twice. */
  onSend: (() => void) | undefined;
  /** What the server would refuse; any at all holds the send. */
  problems: string[];
  /** The server's refusal of the last send; the owner can send again. */
  failed?: string;
}

/** A port of the review harness's ReviewScreen: every answer by section, the open ones filterable and one step away. */
export function RoundCheck({ manifest, groups, general, check, onSend: sendable, problems, failed }: RoundCheckProps): ReactNode {
  const onSend = problems.length > 0 ? undefined : sendable;
  const ref = useRef<HTMLDivElement>(null);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const open = groups.flatMap((group) => group.rows).filter((row) => row.open);
  const total = groups.reduce((count, group) => count + group.rows.length, 0);
  useCheckKeys(check.close, onSend);
  // Focus left on the now-unmounted Send button would drop to the body; the screen takes it so Esc reads as its own.
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const shown = onlyOpen ? groups.map((group) => ({ ...group, rows: group.rows.filter((row) => row.open), frames: [] })).filter((group) => group.rows.length > 0) : groups;
  const next = firstOpen(groups);
  return (
    <div ref={ref} tabIndex={-1} className="outline-none" data-testid="round-check" aria-labelledby="round-check-title">
      <Card variant="outline">
        <CardContent>
          <VStack gap={4}>
            <Heading level={4} nativeID="round-check-title">Check before sending</Heading>
            {next ? <UnansweredNav onlyOpen={onlyOpen} onToggle={() => setOnlyOpen((current) => !current)} onNext={() => check.jumpTo(next.id)} /> : null}
            {shown.map((group) => <CheckSection key={group.id} manifest={manifest} group={group} />)}
            {general.trim() ? <Quote label="Your feedback on this round" text={general.trim()} /> : null}
            {open.length > 0 ? <Alert status="warning" size="compact" testID="round-check-unanswered" message={`${open.length} of ${total} questions are unanswered. Go back to answer them, or send a partial round that lists them as unanswered.`} /> : null}
            {problems.length > 0 ? <Alert status="error" testID="round-check-problems" message={problems.join(" ")} /> : null}
            {failed === undefined ? null : <Alert status="error" message={`Not sent: ${failed}`} />}
            <CheckActions partial={open.length} check={check} onSend={onSend} />
          </VStack>
        </CardContent>
      </Card>
    </div>
  );
}

/** Filter the screen to the open questions, or close it on the first of them, on its own page. */
function UnansweredNav({ onlyOpen, onToggle, onNext }: { onlyOpen: boolean; onToggle: () => void; onNext: () => void }): ReactNode {
  return (
    <HStack gap={2} wrap role="group" aria-label="Unanswered questions">
      <Button size="sm" variant={onlyOpen ? "solid" : "outline"} color="secondary" aria-pressed={onlyOpen} onPress={onToggle} testID="round-check-filter"><ButtonText>Show only unanswered</ButtonText></Button>
      <Button size="sm" variant="outline" onPress={onNext} testID="round-check-next-unanswered"><ButtonText>Answer next unanswered</ButtonText></Button>
    </HStack>
  );
}

function CheckActions({ partial, check, onSend }: { partial: number; check: SendCheck; onSend: (() => void) | undefined }): ReactNode {
  return (
    <VStack gap={1}>
      <HStack gap={3} wrap align="center">
        <Button variant={partial > 0 ? "solid" : "outline"} color={partial > 0 ? "primary" : "secondary"} onPress={check.close} testID="round-check-back"><ButtonText>Back to answering</ButtonText></Button>
        <Button variant={partial > 0 ? "outline" : "solid"} color="primary" isDisabled={onSend === undefined} onPress={() => onSend?.()} testID="round-check-send">
          <ButtonText>{partial > 0 ? `Send partial: ${partial} unanswered` : "Send answers"}</ButtonText>
        </Button>
      </HStack>
      <span className="hidden md:inline">
        <Typography variant="caption" color="secondary">Esc goes back · ⌘ or Ctrl + Enter sends</Typography>
      </span>
    </VStack>
  );
}

function CheckSection({ manifest, group }: { manifest: Manifest; group: CheckGroup }): ReactNode {
  return (
    <VStack gap={2} testID={`round-check-section-${group.id}`}>
      <Typography variant="microLabel" color="secondary">{group.title.toUpperCase()}</Typography>
      {group.frames.map((frame) => <FrameRow key={frame.key} frame={frame} />)}
      {group.rows.map((row) => <AnswerRow key={row.question.id} manifest={manifest} row={row} />)}
    </VStack>
  );
}

function AnswerRow({ manifest, row: { question, position, answer, open } }: { manifest: Manifest; row: CheckRow }): ReactNode {
  const text = answerText(manifest, answer);
  return (
    <div className={open ? "border-l-2 border-warning pl-3" : "border-l-2 border-transparent pl-3"} data-testid={`round-check-answer-${question.id}`} data-unanswered={open || undefined}>
      <VStack gap={1}>
        <Typography variant="subtitle2">{`${position}. `}<InlineMarkdown text={question.prompt} /></Typography>
        <HStack gap={2} wrap align="center">
          <Typography variant="body2" color={text === undefined ? "secondary" : undefined}>{text ?? "No answer"}</Typography>
          {open ? <Pill variant="subtle" size="xs" tone="warning">{question.required ? "required, unanswered" : "unanswered"}</Pill> : null}
        </HStack>
        {(answer?.optionNotes ?? []).map(({ option, note }: { option: string; note: string }) => <Quote key={option} label={`Note on ${option}`} text={note} />)}
        {answer?.comment ? <Quote label="Your comment" text={answer.comment} /> : null}
      </VStack>
    </div>
  );
}

const VERDICT_TONE = { chosen: "success", rejected: "error", maybe: "warning" } as const satisfies Record<CheckVerdict, string>;

function FrameRow({ frame }: { frame: CheckFrame }): ReactNode {
  return (
    <div className="border-l-2 border-transparent pl-3" data-testid={`round-check-frame-${frame.key}`}>
      <VStack gap={1}>
        <HStack gap={2} wrap align="center">
          <Typography variant="subtitle2">{`Frame ${frame.label}`}</Typography>
          <Pill variant="subtle" size="xs" tone={frame.verdict ? VERDICT_TONE[frame.verdict] : "neutral"}>{frame.verdict ?? "no verdict"}</Pill>
        </HStack>
        {frame.comment ? <Quote label="Your comment" text={frame.comment} /> : null}
      </VStack>
    </div>
  );
}

function Quote({ label, text }: { label: string; text: string }): ReactNode {
  return (
    <VStack gap={0}>
      <Typography variant="caption" color="secondary">{label}</Typography>
      <Typography variant="body2">{text}</Typography>
    </VStack>
  );
}
