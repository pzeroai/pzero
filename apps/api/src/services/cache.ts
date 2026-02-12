import { LRUCache } from "lru-cache";

const queryCache = new LRUCache<string, unknown[]>({
  max: 200,
  ttl: 5 * 60 * 1000, // 5 minutes
});

const llmCache = new LRUCache<string, Record<string, unknown>>({
  max: 100,
  ttl: 10 * 60 * 1000, // 10 minutes
});

function hash(input: string): string {
  return Bun.hash(input).toString(36);
}

export function getCachedQuery(sql: string): unknown[] | undefined {
  return queryCache.get(hash(sql));
}

export function setCachedQuery(sql: string, data: unknown[]): void {
  queryCache.set(hash(sql), data);
}

export function getCachedLLM(key: string): Record<string, unknown> | undefined {
  return llmCache.get(hash(key));
}

export function setCachedLLM(key: string, value: Record<string, unknown>): void {
  llmCache.set(hash(key), value);
}
