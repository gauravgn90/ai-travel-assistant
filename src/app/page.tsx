import { Chat } from "@/components/chat";
import { getEnv } from "@/lib/config/env";

export default function HomePage() {
  const { DESTINATION } = getEnv();

  return (
    <main className="app">
      <header className="app-header">
        <div>
          <h1>{DESTINATION} Travel Assistant</h1>
          <p>
            Destination knowledge from a curated guide corpus, live weather and currency through
            MCP tools.
          </p>
        </div>
      </header>
      <Chat destination={DESTINATION} />
    </main>
  );
}
