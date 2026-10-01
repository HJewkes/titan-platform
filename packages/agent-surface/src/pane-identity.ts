import type { LaunchPlan } from "./types.js";

/**
 * What makes an interactive agent's pane recognisable at a glance. The name is
 * the title and the badge; the tab colour says which coordinator the agent
 * belongs to, so every agent of one seat shares the seat's colour.
 *
 * The coordinator is found from the agent's NAME, not its recorded spawner: the
 * launcher reads only the launch plan, and a seat keys its agents by name prefix.
 */

/** A seat's name and the prefix its agents' names start with. */
export interface SeatPrefix {
  name: string;
  prefix: string;
}

/** A `#rrggbb` per seat and per profile, both optional. */
export interface PaneColourConfig {
  seats: Record<string, string>;
  profiles: Record<string, string>;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Mid-brightness hues that stay apart from each other on a dark or a light tab bar. */
export const PANE_PALETTE = [
  "#d9534f",
  "#e8833a",
  "#d4b200",
  "#6aa84f",
  "#2e9e8f",
  "#3d85c6",
  "#674ea7",
  "#c2478f",
  "#8e6c3a",
  "#5b8c2a",
  "#1f6f8b",
  "#a64d79",
] as const;

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

export const isHexColour = (value: unknown): value is string => typeof value === "string" && HEX.test(value);

export function parseHex(hex: string): Rgb | undefined {
  const m = HEX.exec(hex);
  if (m === null) return undefined;
  return { r: parseInt(m[1] ?? "", 16), g: parseInt(m[2] ?? "", 16), b: parseInt(m[3] ?? "", 16) };
}

/** FNV-1a, so a key keeps its colour across processes, machines and Node versions. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text, "utf8")) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash;
}

export const hashedColour = (key: string): string => PANE_PALETTE[fnv1a(key) % PANE_PALETTE.length] ?? "#3d85c6";

/**
 * The coordinator an agent belongs to: the seat it is, or whose prefix its name
 * carries. With no seat to match, the name's first segment stands in for one.
 */
export function coordinatorOf(name: string, seats: readonly SeatPrefix[]): string {
  const seat = seats.find(s => s.name === name) ?? seats.find(s => name.startsWith(`${s.prefix}-`));
  return seat?.name ?? name.split("-")[0] ?? name;
}

/** A seat's colour beats a profile's: one coordinator's agents share a colour whatever their profile. */
export function paneColour(
  name: string,
  profile: string | undefined,
  seats: readonly SeatPrefix[],
  config: PaneColourConfig,
): string {
  const coordinator = coordinatorOf(name, seats);
  return (
    config.seats[coordinator] ??
    (profile === undefined ? undefined : config.profiles[profile]) ??
    hashedColour(coordinator)
  );
}

const OSC = "\x1b]";
const BEL = "\x07";

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

/** Control characters are stripped so a name can never end the title early and start another sequence. */
export const oscTitle = (title: string): string => `${OSC}0;${title.replace(CONTROL_CHARS, "")}${BEL}`;

/** iTerm's proprietary tab colour (OSC 6) and badge (OSC 1337 SetBadgeFormat, base64 of the text). */
export function itermIdentity(name: string, colour: Rgb): string {
  const channel = (which: string, value: number): string => `${OSC}6;1;bg;${which};brightness;${value}${BEL}`;
  const badge = Buffer.from(name, "utf8").toString("base64");
  return (
    channel("red", colour.r) +
    channel("green", colour.g) +
    channel("blue", colour.b) +
    `${OSC}1337;SetBadgeFormat=${badge}${BEL}`
  );
}

export const isITerm = (env: NodeJS.ProcessEnv): boolean => env.TERM_PROGRAM === "iTerm.app";

/** Where the pane's colour comes from: host inputs, so this package reads no charter or config. */
export interface PaneSources {
  seats: () => SeatPrefix[];
  colours: () => PaneColourConfig;
  /** The profile a plan was launched under, for the profile colour; absent means none. */
  profile?: (plan: LaunchPlan) => string | undefined;
}

export const NO_PANE_SOURCES: PaneSources = { seats: () => [], colours: () => ({ seats: {}, profiles: {} }) };

/**
 * Title via OSC 0 rather than iTerm's `set name`, which does not stick: iTerm
 * overwrites it with the running job. In iTerm the tab colour and badge follow;
 * any other terminal gets the title alone, and a headless agent nothing.
 */
export function paneEscapes(plan: LaunchPlan, env: NodeJS.ProcessEnv, sources: PaneSources = NO_PANE_SOURCES): string {
  if (plan.surface === "headless") return "";
  if (!isITerm(env)) return oscTitle(plan.title);
  const colour = paneColour(plan.title, sources.profile?.(plan), sources.seats(), sources.colours());
  const rgb = parseHex(colour);
  return oscTitle(plan.title) + (rgb === undefined ? "" : itermIdentity(plan.title, rgb));
}
