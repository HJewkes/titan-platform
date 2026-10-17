import { isAbsolute } from "node:path";
import { assertAccountLabel, type AccountProfile } from "../profile.js";

export function validateProfile(profile: AccountProfile): void {
  assertAccountLabel(profile.label);
  if (!isAbsolute(profile.codeHome) || profile.codeHome.includes("\0")) {
    throw new TypeError("codeHome must be an explicit absolute directory");
  }
}
