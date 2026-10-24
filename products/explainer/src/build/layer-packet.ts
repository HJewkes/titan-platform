import { lexiconEntriesFor, type Lexicon, type LexiconEntry } from "../lexicon.js";
import { DEFAULT_PACKET_MAX_BYTES, type ResolvedSource } from "../packet.js";
import type { ResolvedBeat } from "../resolve-beat.js";
import type { ScriptBeat } from "../script-schema.js";

/**
 * Everything one custom-layer builder sees for its beat (TP-2607): the narration it must land on, the cue targets it
 * must expose as element ids, where the layer sits on the anchor grid, and the facts the beat cites. Nothing about
 * other beats, so an edit to one beat re-keys only that beat's build.
 */
export interface LayerPacket {
  beat_id: string;
  chapter: string;
  spoken: string;
  cues: ScriptBeat["visual"]["cues"];
  framing: ResolvedBeat["framing"];
  anchors: string[];
  scene?: string;
  band: ResolvedBeat["band"];
  planned_s: number;
  fact_ids: string[];
  /** The cited facts the run's facts artifact holds; a cited id it lacks is in `fact_ids` only. */
  sources: ResolvedSource[];
  lexicon: LexiconEntry[];
}

export interface BuiltLayerPacket {
  packet: LayerPacket;
  json: string;
  bytes: number;
}

export interface LayerPacketInput {
  beat: ScriptBeat;
  resolved: Pick<ResolvedBeat, "id" | "layer" | "framing" | "anchors" | "band">;
  facts: ReadonlyMap<string, ResolvedSource>;
  lexicon?: Lexicon;
  maxBytes?: number;
}

/** Builds one custom beat's packet under `buildPacket`'s byte cap. Throws on a beat the resolver did not make custom. */
export function buildLayerPacket(input: LayerPacketInput): BuiltLayerPacket {
  const { beat, resolved, facts, lexicon, maxBytes = DEFAULT_PACKET_MAX_BYTES } = input;
  if (resolved.id !== beat.id) throw new Error(`${beat.id}: resolved row is for beat ${resolved.id}`);
  if (resolved.layer !== "custom") throw new Error(`${beat.id}: resolved to a ${resolved.layer} layer, not a custom one`);
  const packet: LayerPacket = {
    beat_id: beat.id,
    chapter: beat.chapter,
    spoken: beat.spoken,
    cues: beat.visual.cues,
    framing: resolved.framing,
    anchors: resolved.anchors,
    ...(beat.visual.scene === undefined ? {} : { scene: beat.visual.scene }),
    band: resolved.band,
    planned_s: beat.plannedS,
    fact_ids: beat.fact_ids,
    sources: beat.fact_ids.flatMap((id) => facts.get(id) ?? []),
    lexicon: lexicon ? lexiconEntriesFor(lexicon, [beat.spoken]) : [],
  };
  const json = `${JSON.stringify(packet, null, 2)}\n`;
  const bytes = Buffer.byteLength(json);
  if (bytes > maxBytes) throw new Error(`${beat.id}: layer packet is ${bytes} bytes (limit ${maxBytes})`);
  return { packet, json, bytes };
}
