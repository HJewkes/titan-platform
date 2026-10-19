import type { ConversationIdentity } from "../index.js";
import type { CapabilityAssessment } from "./index.js";
import type {
  NormalizedSessionObservation,
  ReadSessionObservationOptions,
  ReadSessionSourceTextOptions,
  SessionObservationReadResult,
  SessionSourceDescriptor,
  SourceTextLocator,
} from "./source.js";

/** Corpus/account roots are bound by the adapter; cwd is only an optional lookup hint. */
export interface HarnessSourceQuery {
  conversation: ConversationIdentity;
  cwd?: string;
}

/** not_written retains an expected location; absent or unreadable evidence is unavailable. */
export type HarnessSourceLookup =
  | { status: "found"; sources: readonly [SessionSourceDescriptor, ...SessionSourceDescriptor[]] }
  | { status: "not_written"; expectedPaths: readonly [string, ...string[]] }
  | { status: "unavailable"; reason: string };

export interface HarnessSourceCapabilities {
  discover: CapabilityAssessment;
  locate: CapabilityAssessment;
  observations: CapabilityAssessment;
  text: CapabilityAssessment;
  /** Assessment only; this port neither classifies finality nor proves a process finished. */
  semanticFinality: CapabilityAssessment;
}

/** Required unsupported/unverified operations must be refused before invocation. */
export interface HarnessSourcePort {
  readonly capabilities: HarnessSourceCapabilities;
  discover(): Promise<readonly SessionSourceDescriptor[]>;
  locate(query: HarnessSourceQuery): Promise<HarnessSourceLookup>;
  readObservations(
    source: SessionSourceDescriptor,
    options?: ReadSessionObservationOptions,
    onDone?: (result: SessionObservationReadResult) => void,
  ): AsyncIterable<NormalizedSessionObservation>;
  readText(
    locator: SourceTextLocator,
    options?: ReadSessionSourceTextOptions,
  ): Promise<string | null>;
}
