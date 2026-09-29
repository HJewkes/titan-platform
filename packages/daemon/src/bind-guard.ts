/** The daemon has no auth, so a bind beyond loopback is refused unless the caller opts in. */
import { isIPv4, isIPv6 } from "node:net";

export class NonLoopbackBindError extends Error {
  constructor(readonly host: string) {
    super(`Refusing to bind unauthenticated daemon to non-loopback host "${host}"; pass allowUnauthenticatedNonLoopback to override`);
    this.name = "NonLoopbackBindError";
  }
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
  return [...left, ...Array<string>(fill).fill("0"), ...right].map((g) => parseInt(g, 16));
}
