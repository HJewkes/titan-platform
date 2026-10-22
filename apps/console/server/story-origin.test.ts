import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { silentLogger, type DaemonHandle } from "@titan-design/daemon";
import type { ConsoleConfig } from "./config.js";
import { startConsoleDaemon } from "./daemon.js";
import { BRIDGE_ERROR_ATTRIBUTE, BRIDGE_PATH, BRIDGE_TAG, type BridgeMessage } from "./story-bridge.js";
import { STORY_BUILD_FILES, STORY_INLINE_SCRIPT, closedPort, importStoryRound, send } from "./test-support.js";

// Synthetic throughout: a temp state dir and a three-file build imported with the lantern-cards fixture round.
let dir: string;
let config: ConsoleConfig;
let handle: DaemonHandle | undefined;
let buildId: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "console-story-origin-"));
  const closed = await closedPort();
  config = {
    port: 0,
    storyPort: 0,
    stateDir: path.join(dir, "state"),
    activeWorkPort: closed,
    agentChatPort: closed,
    factoryPort: closed,
    agentChatTokenPath: path.join(dir, "ui.token"),
    agentChatEventsDbPath: path.join(dir, "events.db"),
    seatPrefixes: [],
    sessionGraphPath: path.join(dir, "graph.sqlite3"),
    codewatchUrl: "http://codewatch.test:7433",
    lanHost: null,
    lanNames: [],
    lanTls: null,
    lanTokenPath: path.join(dir, "state", "lan.token"),
    ownerWrites: false,
    gateAnswers: false,
    inboxDir: path.join(dir, "state", "inbox", "deposits"),
    roundsDir: path.join(dir, "state", "rounds"),
    storybooksDir: path.join(dir, "state", "storybooks"),
    decisionsFile: null,
  };
  buildId = await importStoryRound({ scratch: dir, roundsDir: config.roundsDir, storybooksDir: config.storybooksDir! });
  handle = await startConsoleDaemon({ config, logger: silentLogger });
});

afterEach(async () => {
  await handle?.close();
  handle = undefined;
  await rm(dir, { recursive: true, force: true });
});

const storyPort = (): number => handle!.contentPort!;
const consoleOrigin = (): string => `http://127.0.0.1:${handle!.port}`;
const story = (route: string, method = "GET") => send("127.0.0.1", storyPort(), method, route, { host: `127.0.0.1:${storyPort()}` });
const sb = (rest: string, id = buildId) => story(`/sb/${id}/${rest}`);

const LiveReply = z.object({ data: z.object({ live: z.object({ origin: z.string(), frames: z.record(z.string(), z.object({ url: z.string() })) }) }) });

/** The `frame-ancestors` sources of a response's CSP. */
function frameAncestors(csp: string | string[] | undefined): string[] {
  const directive = String(csp).split(";").map((part) => part.trim()).find((part) => part.startsWith("frame-ancestors "));
  return directive?.split(/\s+/).slice(1) ?? [];
}

describe("the story origin's build routes", () => {
  it("serves iframe.html with exactly one bridge script before </head>, framed only by the console's own origins", async () => {
    const reply = await sb("iframe.html");

    expect(reply.status).toBe(200);
    expect(reply.body.match(/<script[^>]*__bridge\.js/g)).toHaveLength(1);
    expect(reply.body).toContain(`<script src="${BRIDGE_PATH}"></script></head>`);
    expect(frameAncestors(reply.headers["content-security-policy"])).toEqual([consoleOrigin(), `http://localhost:${handle!.port}`]);
    expect(reply.headers["referrer-policy"]).toBe("no-referrer");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves every directive the story CSP pins, with no outside host and no eval", async () => {
    const csp = String((await sb("iframe.html")).headers["content-security-policy"]);

    for (const directive of ["default-src 'self'", "connect-src 'self'", "img-src 'self' data: blob:", "form-action 'none'", "base-uri 'self'", "object-src 'none'"]) expect(csp).toContain(directive);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/\*|https?:\/\/(?!127\.0\.0\.1|localhost)/);
  });

  it("allows iframe.html's own inline scripts by hash, never by 'unsafe-inline'", async () => {
    const csp = String((await sb("iframe.html")).headers["content-security-policy"]);
    const scriptSrc = csp.split("; ").find((directive) => directive.startsWith("script-src "));

    expect(scriptSrc).toBe(`script-src 'self' 'sha256-${createHash("sha256").update(STORY_INLINE_SCRIPT).digest("base64")}'`);
  });

  it("serves a JS asset byte for byte as immutable, with the story CSP", async () => {
    const reply = await sb("assets/a-hash.js");

    expect(reply.status).toBe(200);
    expect(reply.body).toBe(STORY_BUILD_FILES["assets/a-hash.js"]);
    expect(reply.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(reply.headers["cache-control"]).toContain("immutable");
    expect(reply.headers["content-security-policy"]).toContain("frame-ancestors");
  });

  it("answers a build id the store does not hold with the fast-fail page, whose bridge posts error", async () => {
    const reply = await sb("iframe.html", "f".repeat(64));

    expect(reply.status).toBe(404);
    const reason = failureOf(reply.body);
    expect(reason).toBe("the build is not in the console's store");
    expect(runBridge({ failure: reason }).posted).toEqual([{ message: { bridge: BRIDGE_TAG, type: "error", reason }, target: consoleOrigin() }]);
  });

  it("refuses a malformed build id and a staging dir of the store, never resolving either as a path", async () => {
    await mkdir(path.join(config.storybooksDir!, `.stage-${buildId.slice(0, 12)}-x`), { recursive: true });

    const replies = await Promise.all([story("/sb/..%2f..%2fstate/iframe.html"), story(`/sb/.stage-${buildId.slice(0, 12)}-x/iframe.html`), story(`/sb/${buildId.toUpperCase()}/iframe.html`)]);

    expect(replies.map((reply) => [reply.status, failureOf(reply.body)])).toEqual(Array(3).fill([404, "the build is not in the console's store"]));
  });

  it("refuses a build dir that is a symlink in the store, even to a real build", async () => {
    const alias = "e".repeat(64);
    await symlink(path.join(config.storybooksDir!, buildId), path.join(config.storybooksDir!, alias));

    const reply = await sb("iframe.html", alias);

    expect([reply.status, failureOf(reply.body)]).toEqual([404, "the build is not in the console's store"]);
  });

  it("refuses an encoded slash out of the build and a symlink inside it that leads out, and hides dotfiles", async () => {
    await writeFile(path.join(config.stateDir, "secret.txt"), "synthetic secret");
    await symlink(path.join(config.stateDir, "secret.txt"), path.join(config.storybooksDir!, buildId, "assets", "leak.js"));
    await writeFile(path.join(config.storybooksDir!, buildId, ".env"), "SYNTHETIC=1");

    const [encoded, linked, dotfile] = await Promise.all([sb("..%2f..%2fsecret.txt"), sb("assets/leak.js"), sb(".env")]);

    expect([encoded.status, linked.status, dotfile.status]).toEqual([400, 400, 404]);
    for (const reply of [encoded, linked, dotfile]) expect(reply.body).not.toContain("synthetic secret");
    expect(dotfile.body).not.toContain("SYNTHETIC");
  });

  it("answers a POST with 405, and serves no /rpc, /events, /mcp or /auth/login", async () => {
    const post = await story(`/sb/${buildId}/iframe.html`, "POST");
    const others = await Promise.all(["/rpc/rounds.get", "/events", "/mcp", "/auth/login", "/health", "/"].map((route) => story(route)));

    expect(post.status).toBe(405);
    expect(others.map((reply) => reply.status)).toEqual(Array(6).fill(404));
  });
});

describe("the console with the story origin off", () => {
  it("binds no story port and gives rounds.get a null live origin", async () => {
    await handle!.close();
    handle = await startConsoleDaemon({ config: { ...config, storyPort: null }, logger: silentLogger });

    const reply = await send("127.0.0.1", handle.port, "POST", "/rpc/rounds.get", { host: `127.0.0.1:${handle.port}`, "content-type": "application/json", "x-titan-client": "test" }, JSON.stringify({ id: "lantern-cards-r1" }));

    expect(handle.contentPort).toBeUndefined();
    expect(JSON.parse(reply.body)).toMatchObject({ ok: true, data: { live: { origin: null } } });
  });
});

describe("rounds.get on loopback", () => {
  it("names the loopback story origin, where the round's live urls resolve to the build", async () => {
    const reply = await send("127.0.0.1", handle!.port, "POST", "/rpc/rounds.get", { host: `127.0.0.1:${handle!.port}`, "content-type": "application/json", "x-titan-client": "test" }, JSON.stringify({ id: "lantern-cards-r1" }));
    const { live } = LiveReply.parse(JSON.parse(reply.body)).data;

    expect(live.origin).toBe(`http://127.0.0.1:${storyPort()}`);
    const url = new URL(live.frames.compact!.url, live.origin);
    expect(url.pathname).toBe(`/sb/${buildId}/iframe.html`);
    expect((await story(`${url.pathname}${url.search}`)).status).toBe(200);
  });
});

describe("the story bridge", () => {
  it("posts ready to the console origin once Storybook renders, then the root's height", () => {
    const bridge = runBridge({});

    bridge.emit("storyRendered");
    bridge.resize(412.3);

    expect(bridge.posted.filter(({ message }) => message.type !== "boxes")).toEqual([
      { message: { bridge: BRIDGE_TAG, type: "ready" }, target: consoleOrigin() },
      { message: { bridge: BRIDGE_TAG, type: "height", height: 413 }, target: consoleOrigin() },
    ]);
  });

  it("posts nothing at all when ?parent= names an origin that is not the console's", () => {
    const bridge = runBridge({ parent: `https://evil.example:${handle!.port}` });

    bridge.emit("storyRendered");
    bridge.resize(100);

    expect(bridge.posted).toEqual([]);
  });

  it("posts nothing with no ?parent=, or when it is not framed", () => {
    expect(runBridge({ parent: null }).posted).toEqual([]);
    const top = runBridge({ framed: false });
    top.emit("storyRendered");
    expect(top.posted).toEqual([]);
  });

  it("posts Storybook's error once, and no ready after it", () => {
    const bridge = runBridge({});

    bridge.emit("storyMissing");
    bridge.emit("storyRendered");

    expect(bridge.posted).toEqual([{ message: { bridge: BRIDGE_TAG, type: "error", reason: "storyMissing" }, target: consoleOrigin() }]);
  });

  it("stops measuring after 12 heights", () => {
    const bridge = runBridge({});
    bridge.emit("storyRendered");

    for (let i = 0; i < 20; i += 1) bridge.resize(100 + i);

    expect(bridge.posted.filter(({ message }) => message.type === "height")).toHaveLength(12);
  });

  it("reports each element a pin can name after every render, with its testId, role and text", () => {
    const card = { attributes: { "data-testid": "card" }, text: "Lantern   Open", rect: { left: 0, top: 0, width: 390, height: 200 } };
    const button = { attributes: { "data-testid": "card-open", role: "button" }, text: "Open", rect: { left: 16, top: 150, width: 80, height: 32 } };
    const bridge = runBridge({ elements: [card, button] });

    bridge.emit("storyRendered");
    bridge.emit("storyRendered");

    const boxes = bridge.posted.filter(({ message }) => message.type === "boxes");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toEqual({
      message: {
        bridge: BRIDGE_TAG,
        type: "boxes",
        boxes: [
          { x: 0, y: 0, width: 390, height: 200, target: { testId: "card", text: "Lantern Open" } },
          { x: 16, y: 150, width: 80, height: 32, target: { testId: "card-open", role: "button", text: "Open" } },
        ],
      },
      target: consoleOrigin(),
    });
  });

  it("forwards only [, ], Escape and ? from the story, never Enter, a digit, a letter or a held modifier", () => {
    const bridge = runBridge({});
    bridge.emit("storyRendered");

    for (const key of ["1", "Enter", "a", "c", "ArrowDown"]) bridge.press(key);
    bridge.press("]", { metaKey: true });
    bridge.press("Enter", { ctrlKey: true });
    bridge.press("?", { target: { tagName: "INPUT" } });
    for (const key of ["[", "]", "Escape", "?"]) bridge.press(key);

    const keys = bridge.posted.filter(({ message }) => message.type === "key").map(({ message }) => message);
    expect(keys).toEqual(["[", "]", "Escape", "?"].map((key) => ({ bridge: BRIDGE_TAG, type: "key", key })));
  });

  it("pushes the page's args to the story, and once more after the story next renders", () => {
    const bridge = runBridge({});
    const args = { bridge: BRIDGE_TAG, type: "args", args: { phase: "open" } };

    bridge.receive(args);
    bridge.emit("storyRendered");
    bridge.emit("storyRendered");

    const update = { event: "updateStoryArgs", payload: { storyId: "lantern-card--compact", updatedArgs: { phase: "open" } } };
    expect(bridge.emitted).toEqual([update, update]);
  });

  it("takes args only from the console page's own window and origin", () => {
    const bridge = runBridge({});
    const args = { bridge: BRIDGE_TAG, type: "args", args: { phase: "open" } };

    bridge.receive(args, { source: "other" });
    bridge.receive(args, { origin: "https://evil.example" });
    bridge.receive({ type: "args", args: { phase: "open" } });
    bridge.emit("storyRendered");

    expect(bridge.emitted).toEqual([]);
  });
});

/** The fast-fail page's reason, as the browser would read the bridge tag's attribute. */
function failureOf(html: string): string | undefined {
  const match = new RegExp(`<script src="${BRIDGE_PATH}" ${BRIDGE_ERROR_ATTRIBUTE}="([^"]*)">`).exec(html);
  return match?.[1]?.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

interface Posted {
  message: BridgeMessage;
  target: string;
}

/** An element as the bridge reads it for pins: its attributes, text and client rect. */
interface FakeElement {
  attributes: Record<string, string>;
  text?: string;
  tagName?: string;
  rect: { left: number; top: number; width: number; height: number };
}

interface BridgeRun {
  posted: Posted[];
  /** Every `updateStoryArgs` the bridge emitted on Storybook's channel. */
  emitted: { event: string; payload: unknown }[];
  emit(event: string): void;
  resize(bottom: number): void;
  /** A keydown inside the story, as the browser dispatches it on the story's window. */
  press(key: string, init?: { metaKey?: boolean; ctrlKey?: boolean; target?: { tagName: string } }): void;
  /** A postMessage the story's window receives. */
  receive(data: unknown, from?: { source?: "parent" | "other"; origin?: string }): void;
}

interface BridgeSetup {
  /** `?parent=`; defaults to the console's loopback origin, null leaves it out. */
  parent?: string | null;
  failure?: string;
  framed?: boolean;
  elements?: FakeElement[];
}

type Listener = (event: Record<string, unknown>) => void;

/**
 * Runs the bridge text the story origin serves, fetched synchronously beforehand, in a bare VM
 * with a fake frame: the parent window records each postMessage, Storybook's channel, the story's
 * window events and the ResizeObserver are driven by the test.
 */
function runBridge({ parent = consoleOrigin(), failure, framed = true, elements = [] }: BridgeSetup): BridgeRun {
  const posted: Posted[] = [];
  const emitted: BridgeRun["emitted"] = [];
  const handlers = new Map<string, () => void>();
  const listeners = new Map<string, Listener[]>();
  const observers: (() => void)[] = [];
  let bottom = 0;
  const root = { getBoundingClientRect: () => ({ bottom }) };
  const channel = { on: (event: string, handler: () => void) => handlers.set(event, handler), emit: (event: string, payload: unknown) => emitted.push({ event, payload }) };
  const self: Record<string, unknown> = {
    scrollY: 0,
    __STORYBOOK_ADDONS_CHANNEL__: channel,
    addEventListener: (type: string, listener: Listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
  };
  const parentWindow = { postMessage: (message: BridgeMessage, target: string) => posted.push({ message, target }) };
  self.parent = framed ? parentWindow : self;
  const fire = (type: string, event: Record<string, unknown>): void => (listeners.get(type) ?? []).forEach((listener) => listener(event));
  const context = {
    window: self,
    location: { search: parent === null ? "" : `?id=lantern-card--compact&parent=${encodeURIComponent(parent)}` },
    document: {
      currentScript: { getAttribute: (name: string) => (name === BRIDGE_ERROR_ATTRIBUTE ? (failure ?? null) : null) },
      getElementById: (id: string) => (id === "storybook-root" ? root : null),
      querySelectorAll: () =>
        elements.map((element) => ({ tagName: element.tagName ?? "DIV", textContent: element.text ?? "", getAttribute: (name: string) => element.attributes[name] ?? null, getBoundingClientRect: () => element.rect })),
    },
    URLSearchParams,
    setTimeout: () => 0,
    ResizeObserver: class {
      readonly callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe(): void {
        observers.push(() => this.callback());
      }
      disconnect(): void {
        observers.length = 0;
      }
    },
  };
  vm.runInNewContext(bridgeText, context);
  return {
    posted,
    emitted,
    emit: (event) => handlers.get(event)?.(),
    resize: (next) => {
      bottom = next;
      for (const observer of [...observers]) observer();
    },
    press: (key, init = {}) => fire("keydown", { key, metaKey: false, ctrlKey: false, altKey: false, target: null, ...init }),
    receive: (data, { source = "parent", origin = consoleOrigin() } = {}) => fire("message", { data, origin, source: source === "parent" ? parentWindow : {} }),
  };
}

let bridgeText = "";
beforeEach(async () => {
  const reply = await story(BRIDGE_PATH);
  expect(reply.status).toBe(200);
  expect(reply.headers["content-type"]).toBe("text/javascript; charset=utf-8");
  bridgeText = reply.body;
});
