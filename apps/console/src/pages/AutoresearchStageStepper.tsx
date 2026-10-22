import type { ReactNode } from "react";
import { HStack, Pill, type PillTone, StepIndicator, StepLabel, Stepper, StepperStep } from "@titan-design/react-ui";
import type { StageSpan, StageState } from "./autoresearch-lanes.js";
import { formatCost, formatDuration } from "./SessionFormat.js";

/**
 * Interim for TD-1002 (a `Stepper` step meta slot for duration, $ and the running timer): until that ships, each step's
 * label carries the text, and a card, too narrow for a stepper at phone width, carries the reached stages as a wrapping
 * row of pills. Both live in this one file so the swap touches nothing else.
 */
export function AutoresearchStageStepper({ spans, testID }: { spans: readonly StageSpan[]; testID?: string }): ReactNode {
  const active = spans.findIndex((span) => span.state === "active" || span.state === "error");
  return (
    <Stepper activeStep={active === -1 ? spans.length : active} orientation="vertical" testID={testID}>
      {spans.map((span) => (
        <StepperStep key={span.key} status={span.state}>
          <StepIndicator />
          <StepLabel>{spanText(span)}</StepLabel>
        </StepperStep>
      ))}
    </Stepper>
  );
}

const STATE_TONE: Record<StageState, PillTone> = { completed: "success", active: "info", upcoming: "neutral", error: "error" };

export function AutoresearchStageStrip({ spans, testID }: { spans: readonly StageSpan[]; testID?: string }): ReactNode {
  return (
    <HStack gap={1} wrap testID={testID}>
      {spans.map((span) => (
        <Pill key={span.key} variant="subtle" size="xs" tone={STATE_TONE[span.state]}>
          {spanText(span)}
        </Pill>
      ))}
    </HStack>
  );
}

/** A live stage's time ends in an ellipsis, the design's mark for a clock still running. */
function spanText(span: StageSpan): string {
  const time = span.durationMs === null ? "" : ` ${formatDuration(span.durationMs)}${span.state === "active" ? "…" : ""}`;
  const usd = span.usd === null ? "" : ` ${formatCost(span.usd)}`;
  return `${span.short}${time}${usd}`;
}
