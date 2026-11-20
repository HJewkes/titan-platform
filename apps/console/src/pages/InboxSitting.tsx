import type { ReactNode } from "react";
import { HStack, Pill, Typography, VStack } from "@titan-design/react-ui";
import type { SittingStep } from "@titan-design/owner-queue";
import { OP_VERB } from "./inbox-op-verbs.js";
import { canCopy, CopyButton } from "./InboxPage.js";

type StepStatus = "Done" | "Skipped" | "Next" | "To do";

/** The first step with no outcome is the one the owner is on, and the one whose op the row's tap acts on. */
function statusOf(step: SittingStep, index: number, current: number): StepStatus {
  if (step.outcome === "done") return "Done";
  if (step.outcome === "skipped") return "Skipped";
  return index === current ? "Next" : "To do";
}

/** A sitting's steps in order, each with its status, its command and its own copy button; the row's tap is the current step's. */
export function SittingSteps({ itemId, steps }: { itemId: string; steps: readonly SittingStep[] }): ReactNode {
  const current = steps.findIndex((step) => step.outcome === undefined);
  const settled = steps.filter((step) => step.outcome !== undefined).length;
  return (
    <VStack gap={2} testID={`inbox-sitting-${itemId}`}>
      <Typography variant="caption" color="secondary">{`Sitting: ${settled} of ${steps.length} steps done or skipped`}</Typography>
      {steps.map((step, index) => (
        <SittingStepRow key={index} itemId={itemId} number={index + 1} step={step} status={statusOf(step, index, current)} />
      ))}
    </VStack>
  );
}

function SittingStepRow({ itemId, number, step, status }: { itemId: string; number: number; step: SittingStep; status: StepStatus }): ReactNode {
  const tap = step.op === undefined ? undefined : OP_VERB[step.op.kind];
  return (
    <VStack gap={1} testID={`inbox-sitting-${itemId}-step-${number}`}>
      <HStack gap={2} align="center" wrap>
        <Typography variant="body2">{`${number}. ${step.title}`}</Typography>
        <Pill variant={status === "Next" ? "solid" : "subtle"} size="xs">{status}</Pill>
        {tap !== undefined ? <Pill variant="subtle" size="xs">{`Console tap: ${tap}`}</Pill> : null}
      </HStack>
      <HStack gap={2} align="center" wrap>
        <Typography variant="mono">{step.command}</Typography>
        {canCopy() ? <CopyButton command={step.command} /> : null}
      </HStack>
      {step.verify !== undefined ? <Typography variant="caption" color="secondary">{`Check: ${step.verify}`}</Typography> : null}
    </VStack>
  );
}
