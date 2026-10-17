import { isAbsolute } from "node:path";
import { accountLabel, assertAccountLabel, type AccountProfile } from "../profile.js";
import type { readNativeUsage } from "../node/native.js";

export interface CliContext {
  env: Readonly<Record<string, string | undefined>>;
  /** Epoch milliseconds, matching Date.now; the reader and renderer use seconds. */
  now: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
  readNativeUsage?: typeof readNativeUsage;
}
export interface SelectionOptions { codeHome?: string; account?: string; expectedAccountId?: string }
interface Selection { label: string; profile: AccountProfile | null }

export function selectionOf(context: CliContext, options: SelectionOptions): Selection {
  const codeHome = options.codeHome ?? context.env.CODEX_HOME;
  let label: string;
  try {
    label = options.account ?? accountLabel(codeHome ?? ".codex");
    assertAccountLabel(label);
  } catch { return { label: "default", profile: null }; }
  const valid = codeHome !== undefined && isAbsolute(codeHome) && [...codeHome].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
  return { label, profile: valid ? { label, codeHome } : null };
}
