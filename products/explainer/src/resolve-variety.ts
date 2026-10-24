import { loadTypeProfiles, UnknownProfileError } from "./profile-load.js";
import { ResolvedSchema } from "./resolve-stage.js";
import { resolvedVarietyRows, type VarietyRow } from "./variety-lints.js";
import type { CheckInput } from "./workflow/stage-checks.js";

/** The resolved artifact's variety rows, held to the limits of the profile it was resolved under. */
function resolvedVariety(input: CheckInput): VarietyRow[] {
  const resolved = ResolvedSchema.parse(JSON.parse(input.store.readText(input.artifacts.resolved!)));
  const profiles = loadTypeProfiles();
  const profile = profiles.get(resolved.profile);
  if (!profile) throw new UnknownProfileError(resolved.profile, [...profiles.keys()]);
  const { componentMaxShare, templateMaxShare } = profile.layers;
  return resolvedVarietyRows(resolved.beats, { componentMaxShare, templateMaxShare, minFramings: profile.variety.minFramings });
}

/** One resolved row as a `checks:resolve` verdict; its hint names the beats. */
export const resolvedVarietyVerdict = (id: string) => (input: CheckInput): { pass: boolean; detail: string } => {
  const row = resolvedVariety(input).find((candidate) => candidate.id === id);
  if (!row) throw new Error(`no variety row ${id}`);
  return { pass: row.pass, detail: row.hint };
};
