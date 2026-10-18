import type { ReactNode } from "react";
import { Alert, Button, ButtonText, Card, CardContent, Spinner, Typography, VStack } from "@titan-design/react-ui";
import type { ConsoleCommands } from "../../server/commands.js";
import type { Section } from "../../server/round-schema.js";
import type { RoundDetail } from "../../server/rounds.js";
import { useQuery } from "../data/rpc.js";
import { useSubmit } from "../data/submit.js";
import { inOrder, missingRequired, submittedAnswers } from "./RoundAnswers.js";
import { FrameImage } from "./RoundFrame.js";
import { RoundSections, orderedQuestions, useRoundAnswers, type RoundAnswers } from "./RoundSections.js";

type ValidRound = Extract<RoundDetail, { valid: true }>;
type FramesList = ConsoleCommands["rounds.frames"]["result"];

/**
 * A design round: each section's frames as a labelled strip, its `seeAlso` frames as thumbnails, and its questions,
 * sent together through `rounds.submit`. Only keys frames.json lists are fetched; without a valid frames.json the
 * harness answers the round.
 */
export function DesignRound({ round }: { round: ValidRound }): ReactNode {
  const listed = useQuery("rounds.frames", { id: round.id });
  if (listed.status === "loading") return <Spinner size="sm" label="Loading the round's frames" />;
  if (listed.data === undefined || !listed.data.indexed) return <DesignNotice storybookUrl={round.storybookUrl} />;
  return <DesignBody round={round} listed={listed.data} />;
}

/** The fallback for a design round whose frames/frames.json is missing or invalid. */
function DesignNotice({ storybookUrl }: { storybookUrl: string | null }): ReactNode {
  return (
    <Alert status="info" message="design round: open in the harness">
      {storybookUrl ? <Typography variant="caption" color="secondary">{`Its frames come from Storybook at ${storybookUrl}`}</Typography> : null}
    </Alert>
  );
}

function DesignBody({ round, listed }: { round: ValidRound; listed: FramesList }): ReactNode {
  const state = useRoundAnswers(orderedQuestions(round.manifest).flatMap((group) => group.questions));
  const indexed = new Set(listed.frames.filter((frame) => frame.indexed).map((frame) => frame.key));
  const labels = new Map(round.manifest.variants.map((variant) => [variant.key, variant.label]));
  const strip = { roundId: round.id, indexed, labels };
  return (
    <VStack gap={4}>
      <Typography variant="caption" color="secondary">Tap a frame to open it full size.</Typography>
      {round.recommendationsWithheld ? <Typography variant="caption" color="secondary">Recommendations show once the round is answered.</Typography> : null}
      <RoundSections
        manifest={round.manifest}
        state={state}
        textAnswers
        frames={(section) => <SectionFrames section={section} {...strip} />}
      />
      <DesignSend round={round} state={state} />
    </VStack>
  );
}

interface StripProps {
  roundId: string;
  indexed: ReadonlySet<string>;
  labels: ReadonlyMap<string, string>;
}

function SectionFrames({ section, ...strip }: StripProps & { section: Section }): ReactNode {
  if (section.variantKeys.length === 0 && section.seeAlso.length === 0) return null;
  return (
    <VStack gap={3}>
      {section.variantKeys.length > 0 ? <FrameStrip keys={section.variantKeys} size="strip" {...strip} /> : null}
      {section.seeAlso.length > 0 ? (
        <VStack gap={1}>
          <Typography variant="microLabel" color="secondary">SEE ALSO</Typography>
          <FrameStrip keys={section.seeAlso} size="thumb" {...strip} />
        </VStack>
      ) : null}
    </VStack>
  );
}

const STRIP_GRID = {
  strip: "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3",
  thumb: "grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-6",
} as const;

/** One figure per key, labelled from its variant; a key frames.json does not list is named and never fetched. */
function FrameStrip({ keys, size, roundId, indexed, labels }: StripProps & { keys: readonly string[]; size: keyof typeof STRIP_GRID }): ReactNode {
  return (
    <div className={STRIP_GRID[size]}>
      {keys.map((key) => {
        const label = labels.get(key) ?? key;
        return (
          <figure key={key} className="flex min-w-0 flex-col gap-1" data-testid={`${size === "strip" ? "design-frame" : "see-also"}-${key}`}>
            <Typography variant={size === "strip" ? "subtitle2" : "caption"}>{label}</Typography>
            {indexed.has(key) ? (
              <FrameImage roundId={roundId} frameKey={key} view="head" alt={label} />
            ) : (
              <Typography variant="caption" color="secondary">Not in frames.json</Typography>
            )}
          </figure>
        );
      })}
    </div>
  );
}

function DesignSend({ round, state }: { round: ValidRound; state: RoundAnswers }): ReactNode {
  const { available, state: sending, submit } = useSubmit();
  if (round.status === "withdrawn") return <Alert status="warning" message="Withdrawn: a newer round replaced this one." />;
  if (round.status === "sent" || sending.status === "sent") return <Alert status="success" message={sending.status === "sent" && sending.already ? "Already answered" : "Answers sent"} />;
  const answers = submittedAnswers(round.manifest.questions, state.answers);
  const missing = missingRequired(round.manifest.questions, answers);
  const send = () => submit({ id: round.id, manifestSha256: round.manifestSha256, general: "", answers: inOrder(round.manifest, answers) });
  return (
    <Card variant="outline">
      <CardContent>
        <VStack gap={3}>
          <Button color="primary" isDisabled={!available || sending.status === "sending" || missing.length > 0} onPress={() => void send()}><ButtonText>Send answers</ButtonText></Button>
          {missing.length > 0 ? <Alert status="warning" size="compact" message={`Answer the required ${missing.length === 1 ? "question" : "questions"} first: ${missing.map((question) => question.prompt).join("; ")}`} /> : null}
          {available ? null : <Typography variant="caption" color="secondary">This page is a snapshot: answer from the live console.</Typography>}
          {sending.status === "failed" ? <Alert status="error" message={`Not sent: ${sending.error}`} /> : null}
        </VStack>
      </CardContent>
    </Card>
  );
}
