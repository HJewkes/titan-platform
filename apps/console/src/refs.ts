import type { Route } from "./router.js";

/** The ref classes: active-work's three, and the four the console adds. */
export const REF_CLASSES = ["task", "note", "source", "session", "agent", "pr", "code"] as const;
type RefClass = (typeof REF_CLASSES)[number];

/** Where a ref leads: a console route, a pull request on GitHub, or a file in the codewatch app. */
export type RefTarget =
  | { kind: "route"; route: Route }
  | { kind: "github"; url: string }
  | { kind: "codewatch"; repo: string; path: string };

const PR_BODY = /^([^/\s]+)\/([^#\s]+)#(\d+)$/;
const CODE_BODY = /^([^:\s]+):(.+)$/;

function routeFor(refClass: RefClass, body: string, ref: string): RefTarget | undefined {
  switch (refClass) {
    case "task":
      return { kind: "route", route: { view: "tasks", id: body } };
    case "session":
      return { kind: "route", route: { view: "sessions", id: body } };
    case "agent":
      return { kind: "route", route: { view: "agents", id: body } };
    case "note":
    case "source":
      // The knowledge page reads the whole ref, so a note and a source with the same path stay apart.
      return { kind: "route", route: { view: "knowledge", id: ref } };
    case "pr": {
      const [, owner, repo, number] = PR_BODY.exec(body) ?? [];
      return owner && repo && number ? { kind: "github", url: `https://github.com/${owner}/${repo}/pull/${number}` } : undefined;
    }
    case "code": {
      const [, repo, path] = CODE_BODY.exec(body) ?? [];
      return repo && path ? { kind: "codewatch", repo, path } : undefined;
    }
  }
}

/** The one place a palette result, search hit, graph node or chat mention turns into a destination. */
export function refToRoute(ref: string): RefTarget | undefined {
  const colon = ref.indexOf(":");
  if (colon === -1) return undefined;
  const refClass = REF_CLASSES.find((name) => name === ref.slice(0, colon));
  const body = ref.slice(colon + 1);
  return refClass && body ? routeFor(refClass, body, ref) : undefined;
}

const TASK_ID = /^([A-Z][A-Z0-9]*)-\d+[a-z]?$/;

/** `TP-830` gives `TP`; active-work stamps every task id with its initiative's prefix. */
function taskPrefix(id: string): string | undefined {
  return TASK_ID.exec(id)?.[1];
}

/** The initiative a task id belongs to, matched against each portfolio row's brief `taskPrefix`. */
export function initiativeForTask(id: string, initiatives: readonly { slug: string; taskPrefix?: string }[]): string | undefined {
  const prefix = taskPrefix(id);
  return prefix ? initiatives.find((row) => row.taskPrefix === prefix)?.slug : undefined;
}
