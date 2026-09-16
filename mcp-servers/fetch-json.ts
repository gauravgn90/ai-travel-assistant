/** Both upstreams are free public APIs with no SLA, so one retry on a transport
 *  error or a 5xx is worth it. A 4xx is the caller's mistake and is raised at once. */
export async function fetchJson<T>(url: string): Promise<T> {
  let last = "";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });

      if (response.status >= 400 && response.status < 500) {
        throw new Error(`the service rejected the request (HTTP ${response.status})`);
      }
      if (!response.ok) {
        last = `HTTP ${response.status}`;
        continue;
      }

      return (await response.json()) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("the service rejected")) throw error;
      last = message === "The operation was aborted due to timeout" ? "request timed out" : message;
    }
  }

  throw new Error(`could not reach the service (${last})`);
}
