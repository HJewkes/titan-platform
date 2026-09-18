import * as fs from "node:fs/promises";
import { ProfileSchema, type Profile } from "./schema/profile.js";

export async function readProfile(filePath: string): Promise<Profile> {
  const raw = await fs.readFile(filePath, "utf-8");
  const json: unknown = JSON.parse(raw);
  return ProfileSchema.parse(json);
}

export async function writeProfile(
  filePath: string,
  profile: unknown,
): Promise<void> {
  const validated = ProfileSchema.parse(profile);
  await fs.writeFile(filePath, JSON.stringify(validated, null, 2) + "\n");
}

export function validateProfile(data: unknown) {
  return ProfileSchema.safeParse(data);
}
