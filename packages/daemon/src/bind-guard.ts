/**
 * The main listener has no auth, so a bind beyond loopback is refused unless the caller opts in.
 * The authenticated remote listener is the opposite: it must name one concrete non-loopback
 * address, never a wildcard, which would also expose every bridge and VPN interface.
 */
import { BlockList, isIP, isIPv4, isIPv6 } from "node:net";
import { networkInterfaces } from "node:os";

export class NonLoopbackBindError extends Error {
  constructor(readonly host: string) {
    super(`Refusing to bind unauthenticated daemon to non-loopback host "${host}"; pass allowUnauthenticatedNonLoopback to override`);
    this.name = "NonLoopbackBindError";
  }
}

export class RemoteBindError extends Error {
  constructor(readonly host: string, reason: string) {
    super(`Refusing remote listener on "${host}": ${reason}`);
    this.name = "RemoteBindError";
  }
}

// BlockList matches IPv4-mapped IPv6 forms against the IPv4 rules, so ::ffff:0.0.0.0 is caught too.
const NOT_REMOTE = new BlockList();
NOT_REMOTE.addSubnet("0.0.0.0", 8, "ipv4");
NOT_REMOTE.addSubnet("127.0.0.0", 8, "ipv4");
NOT_REMOTE.addAddress("::", "ipv6");
NOT_REMOTE.addAddress("::1", "ipv6");

/** Names are refused outright: one could resolve to loopback or to the wildcard at bind time. */
export function assertRemoteHost(host: string): void {
  const family = isIP(host);
  if (family === 0) throw new RemoteBindError(host, "it is not a bare IP address literal");
  if (NOT_REMOTE.check(host, family === 4 ? "ipv4" : "ipv6")) {
    throw new RemoteBindError(host, "it is loopback or a wildcard; the remote listener needs one interface address");
  }
}

/** Whether a peer address belongs to this machine: loopback, or any address on a local interface. */
export function isOwnAddress(address: string): boolean {
  const bare = normalizeAddress(address);
  if (isLoopbackHost(bare)) return true;
  return Object.values(networkInterfaces()).some((list) => list?.some((i) => normalizeAddress(i.address) === bare));
}

function normalizeAddress(address: string): string {
  const unzoned = address.toLowerCase().split("%")[0]!;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(unzoned);
  return mapped ? mapped[1]! : unzoned;
}

/** Pure syntax check: names other than `localhost` are never resolved. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare.toLowerCase() === "localhost") return true;
  if (isIPv4(bare)) return bare.startsWith("127.");
  return isIPv6(bare) && isLoopbackV6(bare);
}

function isLoopbackV6(address: string): boolean {
  const mapped = /^(?:0{0,4}:){0,4}:?ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isIPv4(mapped[1]!) && mapped[1]!.startsWith("127.");
  const groups = expandV6(address);
  return groups !== null && groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
}

function expandV6(address: string): number[] | null {
  const [head = "", tail, extra] = address.split("::");
  if (extra !== undefined) return null;
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  if (fill < 0 || (tail === undefined && left.length !== 8)) return null;
  const groupsText = [...left, ...Array<string>(fill).fill("0"), ...right];
  // Anything that is not plain hex (a dotted tail, a zone id) is not understood, so it is refused.
  if (!groupsText.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groupsText.map((g) => parseInt(g, 16));
}
