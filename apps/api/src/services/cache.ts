import { LRUCache } from "lru-cache";

const QUERY_CACHE_MAX_ENTRIES = Number(process.env.QUERY_CACHE_MAX_ENTRIES || "50");
const QUERY_CACHE_TTL_MS = Number(process.env.QUERY_CACHE_TTL_MS || String(5 * 60 * 1000));
const QUERY_CACHE_MAX_BYTES = Number(process.env.QUERY_CACHE_MAX_BYTES || String(32 * 1024 * 1024));
const QUERY_CACHE_MAX_ENTRY_BYTES = Number(
  process.env.QUERY_CACHE_MAX_ENTRY_BYTES || String(2 * 1024 * 1024),
);
const LLM_CACHE_MAX_ENTRIES = Number(process.env.LLM_CACHE_MAX_ENTRIES || "100");
const LLM_CACHE_TTL_MS = Number(process.env.LLM_CACHE_TTL_MS || String(10 * 60 * 1000));

function estimateResultSizeBytes(rows: unknown[]): number {
  if (rows.length === 0) return 64;
  const first = rows[0];
  const cols =
    first && typeof first === "object" && !Array.isArray(first)
      ? Object.keys(first as Record<string, unknown>).length
      : 1;
  // Lightweight upper-bound estimate to keep cache memory bounded.
  return 64 + rows.length * Math.max(1, cols) * 48;
}

const queryCache = new LRUCache<string, unknown[]>({
  max: Math.max(1, Math.floor(QUERY_CACHE_MAX_ENTRIES)),
  maxSize: Math.max(1, Math.floor(QUERY_CACHE_MAX_BYTES)),
  sizeCalculation: (value) => estimateResultSizeBytes(value),
  ttl: Math.max(1_000, Math.floor(QUERY_CACHE_TTL_MS)),
});

const llmCache = new LRUCache<string, Record<string, unknown>>({
  max: Math.max(1, Math.floor(LLM_CACHE_MAX_ENTRIES)),
  ttl: Math.max(1_000, Math.floor(LLM_CACHE_TTL_MS)),
});

function hash(input: string): string {
  return Bun.hash(input).toString(36);
}

export function getCachedQuery(sql: string): unknown[] | undefined {
  return queryCache.get(hash(sql));
}

export function setCachedQuery(sql: string, data: unknown[]): void {
  if (estimateResultSizeBytes(data) > QUERY_CACHE_MAX_ENTRY_BYTES) return;
  queryCache.set(hash(sql), data);
}

export function getCachedLLM(key: string): Record<string, unknown> | undefined {
  return llmCache.get(hash(key));
}

export function setCachedLLM(key: string, value: Record<string, unknown>): void {
  llmCache.set(hash(key), value);
}
