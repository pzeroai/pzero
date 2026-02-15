import { withRetry } from "../common/retry";
import { type KalshiMarket, type KalshiTrade, marketFromApi, tradeFromApi } from "./models";

const KALSHI_API_HOST = "https://api.elections.kalshi.com/trade-api/v2";
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.KALSHI_RATE_LIMIT_MAX_REQUESTS || "80");
const RATE_LIMIT_WINDOW_MS = Number(process.env.KALSHI_RATE_LIMIT_WINDOW_MS || "10000");

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;

  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1000);
  }

  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return null;
}

export class KalshiClient {
  private baseUrl: string;
  private requestTimestamps: number[];
  private maxRequests: number;
  private windowMs: number;

  constructor(baseUrl = KALSHI_API_HOST) {
    this.baseUrl = baseUrl;
    this.requestTimestamps = [];
    this.maxRequests = Math.max(1, Math.floor(RATE_LIMIT_MAX_REQUESTS));
    this.windowMs = Math.max(1000, Math.floor(RATE_LIMIT_WINDOW_MS));
  }

  private async acquireRateLimit(): Promise<void> {
    while (true) {
      const now = Date.now();
      while (
        this.requestTimestamps.length > 0 &&
        now - this.requestTimestamps[0] >= this.windowMs
      ) {
        this.requestTimestamps.shift();
      }
      if (this.requestTimestamps.length < this.maxRequests) {
        this.requestTimestamps.push(now);
        return;
      }
      const waitMs = this.windowMs - (now - this.requestTimestamps[0]) + 1;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  private async get(path: string, params?: Record<string, string | number>): Promise<unknown> {
    return withRetry(async () => {
      const url = new URL(this.baseUrl + path);
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }
      }
      await this.acquireRateLimit();
      const res = await fetch(url.toString(), {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const err = new Error(`Kalshi API ${res.status}: ${res.statusText}`);
        (err as any).status = res.status;
        if (res.status === 429) {
          const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
          if (retryAfterMs != null) {
            (err as any).retryAfterMs = retryAfterMs;
          }
        }
        throw err;
      }
      return res.json();
    });
  }

  async *iterMarkets(opts: {
    limit?: number;
    cursor?: string | null;
    minCloseTs?: number;
    maxCloseTs?: number;
    minCreatedTs?: number;
    maxCreatedTs?: number;
  } = {}): AsyncGenerator<{ markets: KalshiMarket[]; cursor: string | null }> {
    let cursor = opts.cursor ?? null;
    const limit = opts.limit ?? 1000;
    const seenCursors = new Set<string>();

    while (true) {
      const params: Record<string, string | number> = { limit };
      if (cursor && seenCursors.has(cursor)) {
        throw new Error(`Kalshi markets cursor repeated: ${cursor}`);
      }
      if (cursor) {
        seenCursors.add(cursor);
      }
      if (cursor) params.cursor = cursor;
      if (opts.minCloseTs !== undefined) params.min_close_ts = opts.minCloseTs;
      if (opts.maxCloseTs !== undefined) params.max_close_ts = opts.maxCloseTs;
      if (opts.minCreatedTs !== undefined) params.min_created_ts = opts.minCreatedTs;
      if (opts.maxCreatedTs !== undefined) params.max_created_ts = opts.maxCreatedTs;

      const data = (await this.get("/markets", params)) as Record<string, unknown>;
      const markets = ((data.markets as unknown[]) ?? []).map(
        (m) => marketFromApi(m as Record<string, unknown>),
      );
      cursor = (data.cursor as string) || null;

      yield { markets, cursor };

      if (!cursor) break;
    }
  }

  /**
   * Iterate through ALL trades globally (no ticker required).
   * Use minTs for incremental updates.
   */
  async *iterTrades(opts: {
    limit?: number;
    cursor?: string | null;
    minTs?: number;
    maxTs?: number;
    ticker?: string;
  } = {}): AsyncGenerator<{ trades: KalshiTrade[]; cursor: string | null }> {
    let cursor = opts.cursor ?? null;
    const limit = opts.limit ?? 1000;
    const seenCursors = new Set<string>();

    while (true) {
      const params: Record<string, string | number> = { limit };
      if (cursor && seenCursors.has(cursor)) {
        throw new Error(`Kalshi trades cursor repeated: ${cursor}`);
      }
      if (cursor) {
        seenCursors.add(cursor);
      }
      if (cursor) params.cursor = cursor;
      if (opts.minTs !== undefined) params.min_ts = opts.minTs;
      if (opts.maxTs !== undefined) params.max_ts = opts.maxTs;
      if (opts.ticker) params.ticker = opts.ticker;

      const data = (await this.get("/markets/trades", params)) as Record<string, unknown>;
      const trades = ((data.trades as unknown[]) ?? []).map(
        (t) => tradeFromApi(t as Record<string, unknown>),
      );
      cursor = (data.cursor as string) || null;

      yield { trades, cursor };

      if (!cursor) break;
    }
  }
}
