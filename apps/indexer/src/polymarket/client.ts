import { withRetry } from "../common/retry";
import { type PolymarketMarket, marketFromApi } from "./models";

const GAMMA_API_URL = "https://gamma-api.polymarket.com";

export class PolymarketClient {
  private baseUrl: string;

  constructor(baseUrl = GAMMA_API_URL) {
    this.baseUrl = baseUrl;
  }

  private async get(
    url: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<unknown> {
    return withRetry(async () => {
      const u = new URL(url);
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
        }
      }
      const res = await fetch(u.toString(), {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const err = new Error(`Polymarket API ${res.status}: ${res.statusText}`);
        (err as any).status = res.status;
        throw err;
      }
      return res.json();
    });
  }

  async *iterMarkets(opts: {
    limit?: number;
    offset?: number;
    order?: string;
    ascending?: boolean;
  } = {}): AsyncGenerator<{
    markets: PolymarketMarket[];
    nextOffset: number;
  }> {
    let offset = opts.offset ?? 0;
    const limit = opts.limit ?? 500;

    while (true) {
      const data = await this.get(`${this.baseUrl}/markets`, {
        limit,
        offset,
        order: opts.order,
        ascending: opts.ascending,
      });
      const arr = Array.isArray(data) ? data : (data as any).markets ?? data;
      const markets = (arr as Record<string, unknown>[]).map(marketFromApi);

      if (markets.length === 0) {
        yield { markets: [], nextOffset: -1 };
        break;
      }

      offset += markets.length;
      yield { markets, nextOffset: offset };

      if (markets.length < limit) break;
    }
  }

  async fetchMarketsPage(opts: {
    offset: number;
    limit?: number;
    order?: string;
    ascending?: boolean;
  }): Promise<{ markets: PolymarketMarket[]; nextOffset: number }> {
    const limit = opts.limit ?? 500;
    const data = await this.get(`${this.baseUrl}/markets`, {
      limit,
      offset: opts.offset,
      order: opts.order,
      ascending: opts.ascending,
    });
    const arr = Array.isArray(data) ? data : (data as any).markets ?? data;
    const markets = (arr as Record<string, unknown>[]).map(marketFromApi);
    if (markets.length === 0) {
      return { markets, nextOffset: -1 };
    }
    return {
      markets,
      nextOffset: opts.offset + markets.length,
    };
  }
}
