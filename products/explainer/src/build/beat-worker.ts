import { z } from "zod";
import { ANCHOR_SPEC_PATTERN } from "../anchor-grid.js";
import { canonicalJson } from "../eval-store.js";
import { sha256 } from "../workflow/artifacts.js";
import { StageUsageSchema, type StageUsage } from "../workflow/records.js";
import type { BuiltLayerPacket, LayerPacket } from "./layer-packet.js";

/** The only runners a custom layer is built by: a one-shot print call, and an agent-chat agent for repairs. No fork runner. */
export const BEAT_WORKER_IDS = ["claude-print", "agent-chat"] as const;

/** Who builds a layer, down to the base prompt's sha, so any change to the builder re-keys every build. */
export const BuilderRefSchema = z.strictObject({
  id: z.enum(BEAT_WORKER_IDS),
  version: z.string().min(1),
  model: z.string().min(1),
  basePromptSha: z.string().min(1),
});
export type BuilderRef = z.infer<typeof BuilderRefSchema>;

/** One built layer: editable TSX source, the grid cells it declares, the element ids its cues can target, and its spend. */
export const LayerBuildSchema = z.object({
  module: z.string().min(1),
  anchors: z.array(z.string().regex(ANCHOR_SPEC_PATTERN)).min(1),
  elements: z.array(z.string().min(1)),
  usage: StageUsageSchema,
  /** The builder's session, kept so its spend can be joined to the session's transcript. */
  sessionId: z.string().min(1).optional(),
  /** The repair agent's session, when a repair round ran; `usage` includes its spend. */
  repairSessionId: z.string().min(1).optional(),
});
export type LayerBuild = z.infer<typeof LayerBuildSchema>;

export interface BeatWorker {
  readonly builder: BuilderRef;
  build(packet: BuiltLayerPacket, options: { signal?: AbortSignal }): Promise<LayerBuild>;
}

/** A build that failed the compile gate, and where its one repair round may write. */
export interface RepairRequest {
  packet: BuiltLayerPacket;
  /** The build's packet key: it names the repair agent, so two items never share one. */
  key: string;
  module: string;
  error: string;
  /** An empty directory under the run's data dir; the agent writes `<beat>.tsx` into it. */
  scratchDir: string;
}

/** What one repair round left: the module it wrote (none if it wrote nothing), and its spend, priced from its transcript. */
export interface LayerRepair {
  module?: string;
  usage: StageUsage;
  sessionId?: string;
  /** Why the round ended without a result to read, after the agent was started. */
  error?: string;
}

/** Repairs a layer that failed the compile gate; one round per call, the caller re-runs the gate. */
export interface LayerRepairer {
  readonly id: "agent-chat";
  repair(request: RepairRequest, options: { signal?: AbortSignal }): Promise<LayerRepair>;
}

/**
 * A build's memo key: the packet's content and the builder, never the beat id alone, so an edited beat rebuilds and
 * an unchanged one is reused.
 */
export const packetKey = (packet: LayerPacket, builder: BuilderRef): string => sha256(canonicalJson({ packet, builder }));
