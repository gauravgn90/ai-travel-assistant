import { readFile } from "node:fs/promises";
import path from "node:path";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Chat from "@/components/chat";
import { config } from "@/lib/config";

/** Links in the README point at the source guides and the provider consoles, so
 *  they open in a new tab rather than taking the reader out of a conversation. */
function ExternalLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export default async function Page() {
  // Read at build time: the file ships with the app and changes on a deploy,
  // not on a request.
  const readme = await readFile(path.join(process.cwd(), "README.md"), "utf8");

  return (
    <main>
      <header>
        <h1>{config.destination} Travel Assistant</h1>
        <p>
          Destination answers come from a set of indexed travel guides. Weather and currency come
          from live tools.
        </p>
      </header>

      <div className="layout">
        <Chat destination={config.destination} />

        <aside className="reference">
          <h2>README</h2>
          <div className="readme-body">
            <Markdown remarkPlugins={[remarkGfm]} components={{ a: ExternalLink }}>
              {readme}
            </Markdown>
          </div>
        </aside>
      </div>
    </main>
  );
}
