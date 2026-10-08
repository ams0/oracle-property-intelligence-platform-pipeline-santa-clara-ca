import { setTimeout as sleep } from "node:timers/promises";

export interface FetchStats {
  requests: number;
  retries: number;
  bytes: number;
  ms: number;
}

export const newStats = (): FetchStats => ({ requests: 0, retries: 0, bytes: 0, ms: 0 });

const USER_AGENT =
  "oracle-scc-pipeline/0.1 (+https://github.com/prismteam-ai/oracle-property-intelligence-platform-pipeline-santa-clara-ca)";

/**
 * Fetch with bounded exponential backoff. Honours Retry-After. Every external source goes
 * through here so request counts, retries and latency land in the run record.
 */
export async function fetchWithRetry(
  url: string,
  stats: FetchStats,
  init: RequestInit = {},
  { attempts = 5, timeoutMs = 120_000 } = {},
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const started = Date.now();
    try {
      stats.requests++;
      const res = await fetch(url, {
        ...init,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": USER_AGENT, ...(init.headers ?? {}) },
      });
      stats.ms += Date.now() - started;
      if (res.ok) return res;
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        lastError = new Error(`HTTP ${res.status} for ${url}`);
        stats.retries++;
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      throw new Error(`HTTP ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
    } catch (err) {
      stats.ms += Date.now() - started;
      lastError = err;
      if (err instanceof Error && err.message.startsWith("HTTP 4")) throw err;
      stats.retries++;
      await sleep(backoff(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

const backoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;

export async function fetchJson<T>(url: string, stats: FetchStats, init?: RequestInit): Promise<T> {
  const res = await fetchWithRetry(url, stats, init);
  const text = await res.text();
  stats.bytes += text.length;
  return JSON.parse(text) as T;
}

export async function fetchText(url: string, stats: FetchStats, init?: RequestInit): Promise<string> {
  const res = await fetchWithRetry(url, stats, init, { attempts: 4, timeoutMs: 600_000 });
  const text = await res.text();
  stats.bytes += text.length;
  return text;
}

/** Run async work over items with bounded concurrency, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return out;
}
