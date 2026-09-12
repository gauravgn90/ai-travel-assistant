const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = "ai-travel-assistant/1.0 (MCP tool server)";

export class UpstreamError extends Error {
  /** HTTP status when the failure came from a response rather than the transport. */
  status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

export interface FetchJsonOptions {
  timeoutMs?: number;
  /** Extra attempts after the first, with linear backoff. */
  retries?: number;
}

/**
 * Thin JSON fetch with a timeout and bounded retries.
 *
 * Both upstreams are free public APIs with no SLA, so a transient 5xx or a
 * stalled socket is normal and worth one retry. 4xx responses are caller
 * errors and are surfaced immediately.
 */
export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1 } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await delay(attempt * 400);

    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status >= 400 && response.status < 500) {
        throw new UpstreamError(
          `Upstream rejected the request (HTTP ${response.status}).`,
          response.status,
        );
      }
      if (!response.ok) {
        throw new UpstreamError(`Upstream returned HTTP ${response.status}.`, response.status);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof UpstreamError && error.status && error.status < 500) throw error;
      lastError = error;
    }
  }

  throw new UpstreamError(
    `Could not reach the upstream service after ${retries + 1} attempt(s): ${describe(lastError)}`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? "request timed out" : error.message;
  }
  return String(error);
}
