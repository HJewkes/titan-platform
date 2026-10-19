import { expectTypeOf, it } from "vitest";
import type * as Protocol from "@titan-design/agent-protocol/harness";
import type * as Public from "./index.js";
import type * as Normalized from "./normalized.js";
import type * as Reads from "./session-observations.js";

it("preserves source contracts at all existing session-read import paths", () => {
  expectTypeOf<Public.SessionSourceDescriptor>().toEqualTypeOf<Protocol.SessionSourceDescriptor>();
  expectTypeOf<Normalized.NormalizedSessionObservation>().toEqualTypeOf<Protocol.NormalizedSessionObservation>();
  expectTypeOf<Public.SourceTextLocator>().toEqualTypeOf<Protocol.SourceTextLocator>();
  expectTypeOf<Public.SessionFormatDecoder>().toEqualTypeOf<Protocol.SessionFormatDecoder>();
  expectTypeOf<Reads.ReadSessionObservationOptions>().toEqualTypeOf<Protocol.ReadSessionObservationOptions>();
  expectTypeOf<Public.SessionObservationReadResult>().toEqualTypeOf<Protocol.SessionObservationReadResult>();
});
