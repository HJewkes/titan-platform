import { OVERLAY_SHAPES } from "@titan-design/review-panel";
import { z } from "zod";
import { awaitVerdict, bounded, parseAwaitVerdictInput, type AwaitVerdictTiming } from "./await-verdict.js";
import { awaitExternalVerdict, isExternalVerdictInput } from "./external-review.js";
import type { ShepherdDeps } from "./phases.js";
import type { AwaitVerdictResult, ReviewWiring } from "./review.js";
import { thenDropCheckout } from "./review-member.js";

/** A panel member's await names its shape, so its own checkout is the one removed. */
const MemberShapeRead = z.looseObject({ shape: z.enum(OVERLAY_SHAPES).optional() });

/** The sh-await-verdict body; with no reader wired it answers `none` at once, so the owner gate decides. */
export const awaitVerdictStep =
  (deps: ShepherdDeps, wiring: ReviewWiring | undefined, timing: AwaitVerdictTiming) =>
  async (raw: unknown, signal: AbortSignal): Promise<AwaitVerdictResult> => {
    if (isExternalVerdictInput(raw)) return wiring?.dispatch ? bounded(await awaitExternalVerdict(wiring.dispatch.roster, wiring.reader, raw, timing, signal)) : { kind: "none" };
    const input = parseAwaitVerdictInput(raw);
    if (!wiring) return { kind: "none" };
    const { reader, dispatch } = wiring;
    const work = () => awaitVerdict(reader, input, timing, signal, dispatch && (() => dispatch.roster()));
    try {
      return await thenDropCheckout(deps, input, work, (result) => result.kind === "verdict", MemberShapeRead.parse(raw).shape);
    } finally {
      deps.spawnGate?.reviewEnded();
    }
  };
