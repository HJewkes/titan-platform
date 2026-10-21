/**
 * One motion's stills as one viewer (decision 339(2): "a play button (probably autoplay with loop) and a scrubber for
 * animations, static screenshots are not helpful"): one still at a time, Prev and Next, a scrubber over its steps, a
 * button per progress value, and flip-book play that loops. Play is off until pressed, since stills are no clip.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Button, ButtonText, HStack, Typography, VStack } from "@titan-design/react-ui";
import { FrameFigure, useFrameJudging } from "./FrameFeedback.js";
import { FramePinsProvider, useFramePins } from "./FramePins.js";
import type { ProgressStill, StillSequence } from "./progress-stills-heuristic.js";

/** How long each still shows while the sequence plays. */
export const FLIP_MS = 600;

interface FrameSequenceProps {
  sequence: StillSequence;
  label: string;
  step: number;
  onStep: (step: number) => void;
  /** Draws one still; every still is drawn, the ones not shown kept hidden in place, so a flip never waits on a fetch. */
  renderStep: (key: string) => ReactNode;
}

/** Each step's still stacked in one cell; only the shown one is seen, takes presses and draws its figure's pins. */
function StackedSteps({ steps, step, renderStep }: { steps: readonly ProgressStill[]; step: number; renderStep: (key: string) => ReactNode }): ReactNode {
  const pins = useFramePins();
  return (
    <div className="grid">
      {steps.map(({ key }, index) => {
        const shown = index === step;
        return (
          <div key={key} className={shown ? "[grid-area:1/1]" : "invisible [grid-area:1/1]"} aria-hidden={!shown || undefined} inert={!shown} data-testid={shown ? "sequence-shown-step" : undefined}>
            <FramePinsProvider value={shown ? pins : null}>{renderStep(key)}</FramePinsProvider>
          </div>
        );
      })}
    </div>
  );
}

/** Flip-book play: while playing, each still hands on to the next after FLIP_MS, the last back to the first. */
function useFlipBook(count: number, step: number, onStep: (step: number) => void) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => onStep((step + 1) % count), FLIP_MS);
    return () => clearTimeout(timer);
  }, [playing, step, count, onStep]);
  const stepTo = (to: number): void => {
    setPlaying(false);
    onStep(Math.min(count - 1, Math.max(0, to)));
  };
  return { playing, toggle: () => setPlaying(!playing), stepTo };
}

export function FrameSequence({ sequence, label, step, onStep, renderStep }: FrameSequenceProps): ReactNode {
  const { steps } = sequence;
  const flip = useFlipBook(steps.length, step, onStep);
  const shown = steps[step];
  return (
    <VStack gap={2} testID={`frame-sequence-${sequence.base}`}>
      <StackedSteps steps={steps} step={step} renderStep={renderStep} />
      <HStack gap={2} align="center" wrap>
        <Button size="sm" variant="outline" accessibilityLabel={`Previous step of ${label}`} isDisabled={step === 0} onPress={() => flip.stepTo(step - 1)}><ButtonText>Prev</ButtonText></Button>
        <Button size="sm" variant="outline" onPress={flip.toggle}><ButtonText>{flip.playing ? "Pause" : "Play"}</ButtonText></Button>
        <Button size="sm" variant="outline" accessibilityLabel={`Next step of ${label}`} isDisabled={step === steps.length - 1} onPress={() => flip.stepTo(step + 1)}><ButtonText>Next</ButtonText></Button>
        <input
          type="range"
          aria-label={`Scrub ${label}`}
          aria-valuetext={shown ? `progress ${shown.label}` : undefined}
          min={0}
          max={steps.length - 1}
          step={1}
          value={step}
          onChange={(event) => flip.stepTo(Number(event.currentTarget.value))}
          className="min-w-24 flex-1"
        />
        <Typography variant="caption" color="secondary">{`${step + 1} / ${steps.length}`}</Typography>
      </HStack>
      <StepButtons steps={steps} step={step} label={label} stepTo={flip.stepTo} />
    </VStack>
  );
}

/** A button per progress value; a dot marks a still that holds a verdict, a comment or a pin, since only the shown one's are on screen. */
function StepButtons({ steps, step, label, stepTo }: { steps: readonly ProgressStill[]; step: number; label: string; stepTo: (to: number) => void }): ReactNode {
  const judging = useFrameJudging();
  return (
    <div role="group" aria-label={`Steps of ${label}`} className="flex flex-wrap items-center gap-1">
      <Typography variant="caption" color="secondary">Progress:</Typography>
      {steps.map((still, index) => {
        const judged = judging?.judged(still.key) ?? false;
        return (
          <Button key={still.key} size="sm" variant={index === step ? "solid" : "outline"} aria-pressed={index === step} accessibilityLabel={`Step to progress ${still.label}${judged ? ", has feedback" : ""}`} onPress={() => stepTo(index)}>
            <ButtonText>{judged ? `${still.label} •` : still.label}</ButtonText>
          </Button>
        );
      })}
    </div>
  );
}

interface SequenceFigureProps {
  sequence: StillSequence;
  labels: ReadonlyMap<string, string>;
  /** Whether a still takes pins, as its figure would on its own. */
  pinnable: (key: string) => boolean;
  /** The figure's heading for the still shown. */
  header: (label: string) => ReactNode;
  renderStep: (key: string, label: string) => ReactNode;
  id?: string;
  testID?: string;
}

/**
 * A sequence as one figure whose verdict, comment and pins belong to the still shown. Each still stays its own variant
 * key, as rounds.submit's `variants` and the option-to-frame links need, and a pin lands on the PNG it was placed on.
 * Stepping while the figure is active keeps it active on the new still, so the keys judge what is on screen.
 */
export function SequenceFigure({ sequence, labels, pinnable, header, renderStep, id, testID }: SequenceFigureProps): ReactNode {
  const [step, setStep] = useState(0);
  const judging = useFrameJudging();
  const shown = sequence.steps[step] ?? sequence.steps[0];
  if (shown === undefined) return null;
  const labelOf = (key: string): string => labels.get(key) ?? key;
  const label = labelOf(shown.key);
  const onStep = (to: number): void => {
    const next = sequence.steps[to];
    if (next && judging?.activeFrame === shown.key) judging.activateFrame(next.key);
    setStep(to);
  };
  return (
    <FrameFigure frameKey={shown.key} label={label} pinnable={pinnable(shown.key)} id={id} testID={testID}>
      {header(label)}
      <FrameSequence sequence={sequence} label={labelOf(sequence.base)} step={step} onStep={onStep} renderStep={(key) => renderStep(key, labelOf(key))} />
    </FrameFigure>
  );
}
