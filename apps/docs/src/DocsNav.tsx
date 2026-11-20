import { Link, SidebarSection } from "@titan-design/react-ui";
import { NAV, withBase } from "./site-config.js";

// SidebarItem renders `<button href>`, which is no link with JS off; a react-ui Link is a real `<a href>` on web.
// A DOM nav, not a react-native View: only react-ui's own build turns className into classes on a View.
export function DocsNav() {
  return (
    <nav aria-label="Docs" className="w-60 shrink-0 border-r border-hairline">
      <SidebarSection title="Docs">
        {NAV.map((item) => (
          <Link key={item.link} href={withBase(item.link)} className="px-3 py-1.5">
            {item.text}
          </Link>
        ))}
      </SidebarSection>
    </nav>
  );
}
