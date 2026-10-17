import { redactSecrets } from "./redact.js";

export interface AccountProfile {
  label: string;
  codeHome: string;
}

export function assertAccountLabel(label: string): void {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(label) || redactSecrets(label) !== label) {
    throw new TypeError("account label must be a safe non-secret identifier");
  }
}

/** Labels identify an explicitly selected home; they are not authentication identities. */
export function accountLabel(codeHome: string): string {
  const last = codeHome.split(/[\\/]+/).filter(Boolean).at(-1);
  const label = !last || last === ".codex" ? "default" : last.replace(/^\.+/, "");
  assertAccountLabel(label);
  return label;
}
