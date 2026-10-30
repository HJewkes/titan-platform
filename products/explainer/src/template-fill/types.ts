import type { LineSource } from "@titan-design/evidence";
import type { ScriptBeat } from "../script-schema.js";

/** When one slot element lands: the spoken word it appears on, and the compare side when a row has two. */
export interface Reveal {
  target: string;
  part?: "left" | "right";
  atCue: string;
}

/** A later spoken word that names an element already drawn: the view lights the element on it. */
export interface Emphasis {
  target: string;
  atCue: string;
}

/** Page hints the spike sample builder wrote beside a beat's slots; none of them is a slot. */
export interface FillHints {
  placeholder?: true;
  headingYields?: true;
  qaLeadLine?: true;
  continues?: string;
  /** The chapter label is longer than a list title holds, so the list draws untitled. */
  titleOmitted?: true;
}

/** Slots a deriver read off a beat's script fields, with each element's cue word. */
export interface Derived {
  slots: Record<string, unknown>;
  reveals: Reveal[];
  hints?: FillHints;
}

/** Why a beat's fields do not fill its spec, and the spec drawn instead (a list when none is named). */
export interface Underived {
  reason: string;
  fallback?: { spec: string; derived: Derived };
}

export type Derivation = Derived | Underived;

export const isDerived = (found: Derivation): found is Derived => "slots" in found;

/** The stage a chapter's lead beat opened: what a continuation beat keeps of it. */
export interface Lead {
  id: string;
  spec: string;
  heading: Record<string, unknown>;
  field: string;
  items: Record<string, unknown>[];
}

export interface ScopeMap {
  nodes: { id: string; label: string }[];
  edges: { from: string; to: string }[];
}

/** What a beat's derivation reads beyond the beat itself, so each deriver stays a function of its arguments. */
export interface BeatScope {
  chapter: { n: number; label: string; question: string };
  chapterLabels: string[];
  map?: ScopeMap;
  persona?: string;
  code?: LineSource;
  lead?: Lead;
}

export type Deriver = (beat: ScriptBeat, scope: BeatScope) => Derivation;
