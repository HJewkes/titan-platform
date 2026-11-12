import { z } from "zod";

/**
 * `shepherd.visualGate`, a live switch (TP-5408). `async` merges a visual PR on its reviews and green CI and records
 * `visualChanged`; `owner`, or absent, keeps the owner's merge gate. A leaf, so config and phases import no gate code.
 */
export const VisualGateSchema = z.enum(["owner", "async"]);

export type VisualGateMode = z.infer<typeof VisualGateSchema>;
