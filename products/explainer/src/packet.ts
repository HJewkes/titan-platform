import { lexiconEntriesFor, type Lexicon, type LexiconEntry } from "./lexicon.js";
import type { Beat } from "./storyboard.js";
import { findVisualType, shippedVisualRouter, visualCard, type VisualCard, type VisualRouter } from "./visual-router.js";

/** A beat source the route step resolved: a code excerpt cut at a verified citation, or a text fact. */
export interface ResolvedSource {
  id: string;
  kind: "code" | "text";
  text: string;
  /** `path:Lx-Ly@sha` for a code excerpt. */
  cite?: string;
}

export interface PacketInput {
  beat: Beat;
  videoType: string;
  /** Beat type to the component API text a builder may use for it. */
  catalog: ReadonlyMap<string, string>;
  sources: ReadonlyMap<string, ResolvedSource>;
  lexicon?: Lexicon;
  maxBytes?: number;
  /** Defaults to the pinned router in this package's doctrine dir. */
  router?: VisualRouter;
}

/** Everything one beat builder sees: its beat, its component API and its facts, nothing about other beats. */
export interface Packet {
  beat_id: string;
  video_type: string;
  chapter?: string;
  beat: Beat;
  component_api: string;
  /** The router card for the beat's `kind`, gap warning included; absent when the beat names no kind. */
  visual?: VisualCard;
  sources: ResolvedSource[];
  lexicon: LexiconEntry[];
}

export interface BuiltPacket {
  packet: Packet;
  json: string;
  bytes: number;
}

export const DEFAULT_PACKET_MAX_BYTES = 48_000;

const isCodeBeat = (beat: Beat) => /^code(?:-|$)/.test(beat.type);

function resolveSources(beat: Beat, sources: PacketInput["sources"]): ResolvedSource[] {
  const resolved = beat.sources.map((id) => {
    const source = sources.get(id);
    if (!source) throw new Error(`${beat.id}: source ${id} was not resolved`);
    return source;
  });
  if (isCodeBeat(beat) && !resolved.some((s) => s.kind === "code" && s.text.trim() !== "")) {
    throw new Error(`${beat.id}: code beat has no code excerpt`);
  }
  return resolved;
}

function visualFor(beat: Beat, router: VisualRouter = shippedVisualRouter()): { visual?: VisualCard } {
  if (beat.kind === undefined) return {};
  const type = findVisualType(router, beat.kind);
  if (!type) throw new Error(`${beat.id}: kind ${beat.kind} is not a visual-router type`);
  return { visual: visualCard(type) };
}

/** Builds one beat's packet. Throws instead of writing a packet a builder cannot use. */
export function buildPacket(input: PacketInput): BuiltPacket {
  const { beat, catalog, lexicon, maxBytes = DEFAULT_PACKET_MAX_BYTES } = input;
  const componentApi = catalog.get(beat.type);
  if (componentApi === undefined) throw new Error(`${beat.id}: no catalog entry for beat type ${beat.type}`);
  const packet: Packet = {
    beat_id: beat.id,
    video_type: input.videoType,
    ...(beat.chapter ? { chapter: beat.chapter } : {}),
    beat,
    component_api: componentApi,
    ...visualFor(beat, input.router),
    sources: resolveSources(beat, input.sources),
    lexicon: lexicon ? lexiconEntriesFor(lexicon, [beat.spoken, beat.display ?? ""]) : [],
  };
  const json = `${JSON.stringify(packet, null, 2)}\n`;
  const bytes = Buffer.byteLength(json);
  if (bytes > maxBytes) throw new Error(`${beat.id}: packet is ${bytes} bytes (limit ${maxBytes})`);
  return { packet, json, bytes };
}
