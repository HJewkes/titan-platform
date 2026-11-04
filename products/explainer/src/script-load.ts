import { loadProfiles, loadStructures, structureFor, UnknownProfileError } from "./profile-load.js";
import { ScriptSchema, type ScriptV1 } from "./script-schema.js";
import type { NarrativeStructure } from "./structure-schema.js";

/**
 * Parses a script/v1 and checks that the structure and the profile it records are in their registries; an unknown
 * structure throws `UnknownStructureError` and an unknown profile `UnknownProfileError`, here rather than at resolve,
 * after the script calls have spent. The structure registry is read only for a script that names a structure.
 */
export function parseScript(raw: unknown, structures?: ReadonlyMap<string, NarrativeStructure>, profiles?: ReadonlyMap<string, unknown>): ScriptV1 {
  const script = ScriptSchema.parse(raw);
  if (script.structure !== undefined) structureFor(structures ?? loadStructures(), script.structure);
  const known = profiles ?? loadProfiles().profiles;
  if (!known.has(script.profile)) throw new UnknownProfileError(script.profile, [...known.keys()]);
  return script;
}
