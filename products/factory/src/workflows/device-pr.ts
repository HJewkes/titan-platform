import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { defineWorkflow, type StepDeclaration, type WorkflowDefinition } from "../definition.js";
import { oneLine } from "../gate-brief.js";
import { gateEverything } from "../gate-policy.js";
import type { ApprovalAnswer, ApprovalQuestion, AskApproval } from "./land.js";
import { LAND_PR_STEPS, landPr, landPrParams, type LandPrParams } from "./land-pr.js";

/** The device gate's id; it must keep matching `DEVICE_GATE` so only the owner at the device's terminal answers it. */
const DEVICE_CONFIRM = "device-confirm";

const MAX_DEVICE_STEP = 280;
const MAX_SUMMARY = 280;
/** C0 and C1 controls, format characters such as bidi overrides, and line or paragraph separators: none may reach the owner's prompt. */
const NOT_ONE_LINE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const DEVICE_PR_STEPS: readonly StepDeclaration[] = [...LAND_PR_STEPS, { id: DEVICE_CONFIRM, kind: "assisted" }];

interface DevicePrParams extends LandPrParams {
  /** What the owner performs on the device before confirming; the factory never performs it. */
  deviceStep: string;
}

/** Read and check the run's params, so a bad `deviceStep` fails the run before any step records it. */
function devicePrParams(ctx: WorkflowContext): DevicePrParams {
  const deviceStep = ctx.param("deviceStep")?.trim() ?? "";
  if (deviceStep === "") throw new Error("device-pr: param deviceStep is required");
  if (deviceStep.length > MAX_DEVICE_STEP) throw new Error(`device-pr: param deviceStep is over ${MAX_DEVICE_STEP} characters`);
  if (NOT_ONE_LINE.test(deviceStep)) throw new Error("device-pr: param deviceStep must be one line");
  return { ...landPrParams(ctx), deviceStep };
}

/** The payload must name the head shown, so a device result at one head can never carry over to a head nobody tried. */
function deviceDecision(question: ApprovalQuestion, deviceStep: string) {
  const { repo, pr, headSha } = question;
  const schema = z.object({ decision: z.enum(["pass", "fail", "abandon"]), headSha: z.literal(headSha), note: z.string().optional() });
  const options = [
    { id: "pass", label: "The device step passed at this head" },
    { id: "fail", label: "The device step failed at this head" },
    { id: "abandon", label: "Abandon the PR" },
  ];
  const lead = `Perform on the device at ${headSha.slice(0, 8)}: `;
  const summary = `${lead}${oneLine(deviceStep, MAX_SUMMARY - lead.length)}`;
  const evidenceRef = `https://github.com/${repo}/pull/${pr}/commits/${headSha}`;
  return { schema, brief: { summary, evidenceRef, questions: [{ id: "decision", question: `Did the device step pass at ${headSha}?`, options }] } };
}

/** Asks in place of approve-merge; a `fail` reads as a red head, so land-pr's ci-failed gate decides what follows. */
function deviceConfirm(deviceStep: string): AskApproval {
  return async (ctx, question): Promise<ApprovalAnswer> => {
    const { schema, brief } = deviceDecision(question, deviceStep);
    const prompt = `Perform on the device for PR #${question.pr} in ${question.repo} at head ${question.headSha}: ${deviceStep}. Did it pass?`;
    const answer = schema.safeParse((await ctx.assisted(DEVICE_CONFIRM, prompt, { schema, brief })).data);
    if (!answer.success) throw new Error(`${DEVICE_CONFIRM} answer does not name head ${question.headSha}: ${answer.error.message}`);
    const { decision, note } = answer.data;
    if (decision === "pass") return "merge";
    if (decision === "abandon") return "abandon";
    return { failed: note ?? "the device step failed" };
  };
}

/** The registered workflow; params `repo`, `pr`, `deviceStep` and optional `task`. Nothing here talks to a device. */
export function devicePrWorkflow(): WorkflowDefinition {
  return defineWorkflow({
    name: "device-pr",
    steps: DEVICE_PR_STEPS,
    run: async (ctx) => {
      const params = devicePrParams(ctx);
      await landPr(ctx, params, { policy: gateEverything, askApproval: deviceConfirm(params.deviceStep) });
    },
  });
}
