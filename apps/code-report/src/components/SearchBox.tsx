import { useEffect, useState, type ReactNode } from "react";
import { Input } from "@titan-design/react-ui";
import { useQuery } from "../data/rpc.js";
import { nodeHref } from "../router.js";
import { useReport } from "../report-context.js";
import { QueryView } from "./QueryView.js";

const MIN_QUERY = 2;
const DEBOUNCE_MS = 200;

/** Finds any directory, file, or symbol through `node.resolve`; `path:line` lands on the enclosing symbol. */
export function SearchBox(): ReactNode {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <div className="relative w-80">
      <Input size="sm" value={text} onChangeText={setText} placeholder="Find a file, symbol, or path:line" accessibilityLabel="Search nodes" />
      {query.length >= MIN_QUERY && <SearchResults query={query} onPick={() => setText("")} />}
    </div>
  );
}

function SearchResults({ query, onPick }: { query: string; onPick: () => void }): ReactNode {
  const { snapshotId } = useReport();
  const result = useQuery("node.resolve", { snapshot: snapshotId, query, limit: 8 });
  return (
    <div className="absolute z-10 mt-1 w-full rounded border border-hairline bg-surface-overlay p-2 shadow-lg" role="listbox" aria-label="Search results">
      <QueryView result={result} label="matches" isEmpty={(d) => d.candidates.length === 0}>
        {(data) => (
          <ul className="m-0 list-none p-0">
            {data.candidates.map((c) => (
              <li key={c.node.id} role="option" aria-selected={false}>
                <a className="block truncate py-0.5 text-sm text-text-link" href={nodeHref(c.node.id)} onClick={onPick}>
                  {c.node.kind === "symbol" ? `${c.node.name} (${c.node.path})` : c.node.id || "(repo)"}
                </a>
              </li>
            ))}
          </ul>
        )}
      </QueryView>
    </div>
  );
}
