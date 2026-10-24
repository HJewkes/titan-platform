import type { Rule } from "eslint";
import type { CallExpression, Node } from "estree";

export const DEFAULT_MOTION_PATHS: readonly string[] = ["/ui/beats/", "/motion/"];

const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(\/__tests__\/)/;
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "self"]);
const TIMERS = new Set(["setTimeout", "setInterval", "setImmediate", "requestAnimationFrame"]);
const BANNED_MEMBERS: Readonly<Record<string, ReadonlySet<string>>> = {
  Date: new Set(["now"]),
  performance: new Set(["now"]),
  Math: new Set(["random"]),
};

function memberName({ computed, property }: { computed: boolean; property: Node }): string | null {
  if (!computed && property.type === "Identifier") return property.name;
  return property.type === "Literal" && typeof property.value === "string" ? property.value : null;
}

/** `Date.now` as ["Date", "now"]; a leading `globalThis`, `window` or `self` is dropped. Null when the callee is not a plain name path. */
function namePath(callee: Node): string[] | null {
  if (callee.type === "Identifier") return [callee.name];
  if (callee.type !== "MemberExpression") return null;
  const head = namePath(callee.object);
  const tail = memberName(callee);
  if (head === null || tail === null) return null;
  return head.length === 1 && GLOBAL_OBJECTS.has(head[0] ?? "") ? [tail] : [...head, tail];
}

/** The banned clock source a call reads, as written (`Date.now`, `setTimeout`); null for any other call. */
function wallClockCall({ callee }: CallExpression): string | null {
  const [first, second, ...rest] = namePath(callee) ?? [];
  if (first === undefined || rest.length > 0) return null;
  if (second === undefined) return TIMERS.has(first) ? first : null;
  return BANNED_MEMBERS[first]?.has(second) ? `${first}.${second}` : null;
}

function isInScope(filename: string, paths: readonly string[]): boolean {
  const normalized = filename.replaceAll("\\", "/");
  return !TEST_FILE.test(normalized) && paths.some((path) => normalized.includes(path));
}

export const noWallClockMotion: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow wall-clock time and unseeded randomness in beat and motion code" },
    schema: [
      {
        type: "object",
        properties: { paths: { type: "array", items: { type: "string" } } },
        additionalProperties: false,
      },
    ],
    messages: {
      wallClock:
        "`{{call}}` reads the wall clock or an unseeded source, so a seek or a second render shows different frames. Derive motion from the beat's `t` or progress, or from a seeded generator, and never from real time.",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as { paths?: string[] };
    if (!isInScope(context.filename, options.paths ?? DEFAULT_MOTION_PATHS)) return {};
    return {
      CallExpression(node) {
        const call = wallClockCall(node);
        if (call !== null) context.report({ node, messageId: "wallClock", data: { call } });
      },
    };
  },
};
