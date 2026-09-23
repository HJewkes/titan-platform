export interface RegistrationOptions {
  id: string;
  asToken: string;
  hsToken: string;
  /** Where the homeserver pushes transactions; null for a receive-only edge that pulls with /sync. */
  url: string | null;
  senderLocalpart: string;
  /** Machine name inside the namespace: `edge1` owns `@ac-edge1-.*`. */
  machine: string;
  serverName: string;
}

// Letters and digits only, so one machine's prefix can never be a prefix of another's.
const MACHINE = /^[a-z0-9]+$/;
const LOCALPART = /^[a-z0-9._=/-]+$/;

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function machineUserRegex(machine: string, serverName: string): string {
  if (!MACHINE.test(machine)) throw new Error(`machine must match ${MACHINE}: ${JSON.stringify(machine)}`);
  return `^@ac-${machine}-.*:${escapeRegex(serverName)}$`;
}

// JSON strings are valid YAML double-quoted scalars, which also doubles the regex backslashes.
const quote = (value: string) => JSON.stringify(value);

export function renderRegistration(options: RegistrationOptions): string {
  if (!LOCALPART.test(options.senderLocalpart)) throw new Error(`invalid sender localpart: ${JSON.stringify(options.senderLocalpart)}`);
  return [
    `id: ${quote(options.id)}`,
    `url: ${options.url === null ? "null" : quote(options.url)}`,
    `as_token: ${quote(options.asToken)}`,
    `hs_token: ${quote(options.hsToken)}`,
    `sender_localpart: ${options.senderLocalpart}`,
    "rate_limited: false",
    "namespaces:",
    "  users:",
    "    - exclusive: true",
    `      regex: ${quote(machineUserRegex(options.machine, options.serverName))}`,
    "  aliases: []",
    "  rooms: []",
    "",
  ].join("\n");
}
