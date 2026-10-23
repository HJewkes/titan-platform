import { loadStructures, structureFor } from "./profile-load.js";
import { ScriptSchema, type ScriptV1 } from "./script-schema.js";
import type { NarrativeStructure } from "./structure-schema.js";

/**
 * Parses a script/v1 and checks that the structure it records is in the registry; an unknown name
 * throws `UnknownStructureError`. The registry is read only for a script that names a structure.
 */
export function parseScript(raw: unknown, structures?: ReadonlyMap<string, NarrativeStructure>): ScriptV1 {
  const script = ScriptSchema.parse(raw);
  if (script.structure !== undefined) structureFor(structures ?? loadStructures(), script.structure);
  return script;
}
