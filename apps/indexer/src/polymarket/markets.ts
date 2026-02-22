import { join } from "path";
import { Indexer } from "../common/indexer";
import { DATA_DIR as ROOT_DATA_DIR } from "../common/paths";
import { ClickHouseStorage } from "../common/storage";
import { readCursor, writeCursor, deleteCursor } from "../common/cursor";
import { PolymarketClient } from "./client";

const STATE_FILE = join(ROOT_DATA_DIR, "polymarket/.markets_forward_state.json");
const LEGACY_STATE_FILE = join(ROOT_DATA_DIR, "polymarket/.markets_head_state.json");
const LEGACY_WATERMARK_STATE_FILE = join(
  ROOT_DATA_DIR,
  "polymarket/.markets_created_at_state.json",
);
const PAGE_LIMIT = Number(process.env.PM_MARKETS_PAGE_LIMIT || "500");
const FETCH_CONCURRENCY = Number(process.env.PM_MARKETS_FETCH_CONCURRENCY || "16");
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.PM_MARKETS_RATE_LIMIT_MAX_REQUESTS || "280");
const RATE_LIMIT_WINDOW_MS = Number(process.env.PM_MARKETS_RATE_LIMIT_WINDOW_MS || "10000");

interface PolymarketMarketsState {
  nextOffset: number;
  lastCreatedAt: string | null;
}

function parseState(raw: string | null): PolymarketMarketsState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PolymarketMarketsState>;
    const nextOffset =
      typeof parsed.nextOffset === "number" &&
      Number.isFinite(parsed.nextOffset) &&
      parsed.nextOffset >= 0
        ? Math.floor(parsed.nextOffset)
        : 0;
    const lastCreatedAt =
      typeof parsed.lastCreatedAt === "string" && parsed.lastCreatedAt.length > 0
        ? parsed.lastCreatedAt
        : null;
    return { nextOffset, lastCreatedAt };
  } catch {
    return null;
  }
}

function createRateLimiter(maxRequests: number, windowMs: number): () => Promise<void> {
  const timestamps: number[] = [];
  return async () => {
    while (true) {
      const now = Date.now();
      while (timestamps.length > 0 && now - timestamps[0] >= windowMs) {
        timestamps.shift();
      }
      if (timestamps.length < maxRequests) {
        timestamps.push(now);
        return;
      }
      const waitMs = windowMs - (now - timestamps[0]) + 1;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  };
}

export class PolymarketMarketsIndexer extends Indexer {
  constructor() {
    super(
      "polymarket_markets",
      "Indexes Polymarket markets with forward createdAt pagination",
    );
  }

  async run(): Promise<void> {
    const client = new PolymarketClient();
    const storage = new ClickHouseStorage("polymarket_markets");

    try {
      // Cleanup legacy checkpoint files from previous strategies.
      deleteCursor(LEGACY_STATE_FILE);
      deleteCursor(LEGACY_WATERMARK_STATE_FILE);

      const state = parseState(readCursor(STATE_FILE)) ?? {
        nextOffset: 0,
        lastCreatedAt: null,
      };
      let cursorOffset = state.nextOffset;
      let lastCreatedAt = state.lastCreatedAt;
      const concurrency = Math.max(1, Math.floor(FETCH_CONCURRENCY));
      const maxRequests = Math.max(1, Math.floor(RATE_LIMIT_MAX_REQUESTS));
      const windowMs = Math.max(1000, Math.floor(RATE_LIMIT_WINDOW_MS));
      const acquire = createRateLimiter(maxRequests, windowMs);

      console.log(
        `Running forward createdAt crawl from offset=${cursorOffset} (limit=${PAGE_LIMIT}, concurrency=${concurrency}, rate=${maxRequests}/${windowMs}ms)`,
      );

      let totalFetched = 0;
      let totalNew = 0;
      let pages = 0;
      let reachedTail = false;

      while (!reachedTail) {
        const batchStart = cursorOffset;
        const offsets: number[] = [];
        for (let i = 0; i < concurrency; i++) {
          offsets.push(batchStart + i * PAGE_LIMIT);
        }

        const results = await Promise.allSettled(
          offsets.map(async (offset) => {
            await acquire();
            const page = await client.fetchMarketsPage({
              offset,
              limit: PAGE_LIMIT,
              order: "createdAt",
              ascending: true,
            });
            return { offset, ...page };
          }),
        );

        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const offset = offsets[i];

          if (result.status === "rejected") {
            throw new Error(
              `Failed fetching markets page at offset ${offset}: ${String(result.reason)}`,
            );
          }

          if (offset !== cursorOffset) {
            throw new Error(
              `Non-contiguous page commit detected (expected offset ${cursorOffset}, got ${offset})`,
            );
          }

          const { markets, nextOffset: apiNextOffset } = result.value;
          if (markets.length === 0) {
            reachedTail = true;
            console.log(
              "Reached current tail of createdAt-ordered Polymarket markets list",
            );
            break;
          }

          pages++;
          totalFetched += markets.length;

          const dedupedById = new Map<string, Record<string, unknown>>();
          for (const market of markets) {
            dedupedById.set(market.id, market as unknown as Record<string, unknown>);
          }
          const ids = [...dedupedById.keys()];
          const existing = await storage.findExistingKeys("id", ids);

          const fetchedAt = new Date().toISOString();
          const newRecords: Record<string, unknown>[] = [];
          for (const [id, market] of dedupedById) {
            if (existing.has(id)) continue;
            newRecords.push({ ...market, _fetched_at: fetchedAt });
          }

          if (newRecords.length > 0) {
            await storage.writeChunk(newRecords);
            totalNew += newRecords.length;
          }

          let pageLastCreatedAt: string | null = null;
          for (const market of markets) {
            if (market.created_at != null) {
              pageLastCreatedAt = market.created_at;
            }
          }
          if (pageLastCreatedAt) {
            lastCreatedAt = pageLastCreatedAt;
          }

          const resolvedNextOffset =
            apiNextOffset > 0 ? apiNextOffset : cursorOffset + markets.length;
          writeCursor(
            STATE_FILE,
            JSON.stringify({
              nextOffset: resolvedNextOffset,
              lastCreatedAt,
            } satisfies PolymarketMarketsState),
          );
          cursorOffset = resolvedNextOffset;

          const pageLastLabel = pageLastCreatedAt ?? "null";
          console.log(
            `Page ${pages}: fetched ${markets.length}, new ${newRecords.length}, page last createdAt ${pageLastLabel}, nextOffset ${cursorOffset}`,
          );

          if (markets.length < PAGE_LIMIT) {
            reachedTail = true;
            break;
          }
        }
      }

      console.log(
        `\nDiscovery complete: ${totalFetched} fetched, ${totalNew} new markets written`,
      );
    } catch (err) {
      console.error("Error during market indexing. State kept for resume.", err);
      throw err;
    } finally {
      storage.close();
    }
  }
}
