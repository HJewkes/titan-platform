import type {
  BoxProps,
  ElementConstructor,
  EngineInterface,
  HookStream,
  On,
  PluginOptions,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  RenderElement,
  TextProps,
} from "claude-code";
import { fleetView, type Line, type Tone } from "../view-model.js";
import { FeedReader } from "./feed-reader.js";

const PANE = "fleet";
const COMMAND = "fleet";

const COLORS: Partial<Record<Tone, string>> = { ok: "green", warn: "yellow", bad: "red", accent: "cyan" };

/** The two primitives every surface carries, which is all the pane draws with. */
interface Drawing {
  Box: ElementConstructor<BoxProps>;
  Text: ElementConstructor<TextProps>;
}

function drawLine({ Text }: Drawing, line: Line): RenderElement {
  return (
    <Text wrap="truncate">
      {line.map((segment) => {
        if (segment.tone === "plain") return segment.text;
        if (segment.tone === "dim") return <Text dimColor>{segment.text}</Text>;
        return <Text color={COLORS[segment.tone]}>{segment.text}</Text>;
      })}
    </Text>
  );
}

/** Reads the feed until it exits, redrawing the pane on every snapshot. */
async function pump($: EngineInterface, child: HookStream<ProcessSpawnChunk, ProcessSpawnResult>, reader: FeedReader): Promise<void> {
  const chunks = child[Symbol.asyncIterator]();
  try {
    for (let next = await chunks.next(); next.done !== true; next = await chunks.next()) {
      if (next.value.stream === "stderr") reader.stderrText(next.value.text);
      else if (reader.stdout(next.value.text)) $.ui.invalidate("ui.render");
    }
    reader.exited("exited");
  } catch (error) {
    reader.exited(`could not run (${error instanceof Error ? error.message : String(error)})`);
  }
  $.ui.invalidate("ui.render");
}

async function drawPane($: EngineInterface, elements: Drawing, columns: number, reader: FeedReader, feed: string): Promise<RenderElement> {
  const { Box, Text } = elements;
  const problem = reader.problem === null ? null : <Text color="red">{reader.problem}. Run /fleet to start it again.</Text>;
  if (reader.snapshot === null) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Waiting for the fleet feed ({feed})…</Text>
        {problem}
      </Box>
    );
  }
  const view = fleetView(reader.snapshot, await $.clock.now());
  return (
    <Box flexDirection="column" width={columns}>
      {view.header.map((line) => drawLine(elements, line))}
      {problem}
      <Text dimColor>{"─".repeat(Math.max(0, columns))}</Text>
      {view.rows.map((line) => drawLine(elements, line))}
    </Box>
  );
}

interface ModState {
  feed: string;
  reader: FeedReader | null;
}

/** Starts the feed unless one is already running healthy; a stopped one is started again. */
function startFeed($: EngineInterface, state: ModState): void {
  if (state.reader !== null && state.reader.problem === null) return;
  const reader = new FeedReader();
  state.reader = reader;
  void pump($, $.process.spawn({ argv: state.feed.trim().split(/\s+/) }), reader);
}

// Must stay a function declaration: Claude Code finds `register` in the source.
export function register(on: On, options: PluginOptions): void {
  const state: ModState = {
    feed: typeof options.feed === "string" && options.feed !== "" ? options.feed : "titan-fleet-feed",
    reader: null,
  };

  on("session.start", async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: "Show running agents, their accounts, context and spend in a pane" });
    return next(e);
  });

  // Literal filters, so `claude plugin validate` can name what each hook hears.
  on("command.run", { command: "fleet" }, async ($) => {
    startFeed($, state);
    const opened = await $.ui.open({ id: PANE, title: "Fleet" });
    return { text: opened.isPlaced ? "Opened the fleet pane." : `The fleet pane could not open: ${opened.reason ?? "no surface draws it"}.` };
  });

  on("ui.render", { component: "Pane", requestId: "fleet" }, async ($, e) => {
    const elements: Drawing = $.ui.resolve(e);
    if (state.reader !== null) return drawPane($, elements, e.props.bodyColumns, state.reader, state.feed);
    const { Text } = elements;
    return <Text dimColor>Run /fleet to start the fleet feed.</Text>;
  });
}
