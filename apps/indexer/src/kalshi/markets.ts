import { join } from "path";
import { Indexer } from "../common/indexer";
import { DATA_DIR as ROOT_DATA_DIR } from "../common/paths";
import { ClickHouseStorage } from "../common/storage";
import { readCursor, writeCursor } from "../common/cursor";
import { KalshiClient } from "./client";

const STATE_FILE = join(ROOT_DATA_DIR, "kalshi/.markets_state.json");
const PAGE_LIMIT = Number(process.env.KALSHI_MARKETS_PAGE_LIMIT || "1000");
const OVERLAP_SECONDS = Number(process.env.KALSHI_MARKETS_OVERLAP_SECONDS || "300");
const PROGRESS_LOG_EVERY = Number(process.env.KALSHI_MARKETS_PROGRESS_LOG_EVERY || "1");
const CURSOR_LOG_EVERY = Number(process.env.KALSHI_MARKETS_CURSOR_LOG_EVERY || "20");
const RUN_MAX_CREATED_TS = Number(process.env.KALSHI_MARKETS_MAX_CREATED_TS || "0");
const WATERMARK_MAX_FUTURE_SECONDS = Number(
  process.env.KALSHI_MARKETS_WATERMARK_MAX_FUTURE_SECONDS || "0",
);
const MIGRATION_LOOKBACK_SECONDS = Number(
  process.env.KALSHI_MARKETS_MIGRATION_LOOKBACK_SECONDS || "86400",
);

interface KalshiMarketsState {
  version: "created_v1";
  cursor: string | null;
  watermarkCreatedTs: number | null;
  maxSeenCreatedTs: number | null;
  updatedAt: string;
}

interface ParsedKalshiMarketsState {
  source: "created" | "legacy_created" | "close" | "unknown";
  cursor: string | null;
  watermarkCreatedTs: number | null;
  maxSeenCreatedTs: number | null;
  updatedAt: string;
}

function parseNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

function parseState(raw: string | null): ParsedKalshiMarketsState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const cursor =
      typeof parsed.cursor === "string" && parsed.cursor.length > 0
        ? parsed.cursor
        : null;
    const watermarkCreatedTs = parseNonNegativeInt(parsed.watermarkCreatedTs);
    const maxSeenCreatedTs =
      parseNonNegativeInt(parsed.maxSeenCreatedTs) ?? watermarkCreatedTs;
    const hasCreatedFields = "watermarkCreatedTs" in parsed || "maxSeenCreatedTs" in parsed;
    const hasCloseFields = "watermarkCloseTs" in parsed || "maxSeenCloseTs" in parsed;
    const version = typeof parsed.version === "string" ? parsed.version : null;
    let source: ParsedKalshiMarketsState["source"] = "unknown";
    if (version === "created_v1") {
      source = "created";
    } else if (hasCreatedFields) {
      source = "legacy_created";
    } else if (hasCloseFields) {
      source = "close";
    }
    const updatedAt =
      typeof parsed.updatedAt === "string" && parsed.updatedAt.length > 0
        ? parsed.updatedAt
        : new Date(0).toISOString();
    return {
      source,
      cursor,
      watermarkCreatedTs,
      maxSeenCreatedTs,
      updatedAt,
    };
  } catch {
    return null;
  }
}

function toUnixSeconds(ts: string | null): number | null {
  if (!ts) return null;
  const ms = new Date(ts).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function cursorSuffix(cursor: string | null, len = 12): string {
  if (!cursor) return "tail";
  const safeLen = Math.max(4, Math.floor(len));
  return cursor.length <= safeLen ? cursor : cursor.slice(-safeLen);
}

function isLikelyCursorError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return msg.includes("cursor") || msg.includes("invalid");
}

function serializeState(state: KalshiMarketsState): string {
  return JSON.stringify({
    version: state.version,
    cursor: state.cursor,
    watermarkCreatedTs: state.watermarkCreatedTs,
    maxSeenCreatedTs: state.maxSeenCreatedTs,
    updatedAt: state.updatedAt,
  } satisfies KalshiMarketsState);
}

export class KalshiMarketsIndexer extends Indexer {
  constructor() {
    super("kalshi_markets", "Incrementally indexes Kalshi markets data to ClickHouse");
  }

  async run(): Promise<void> {
    const client = new KalshiClient();
    const storage = new ClickHouseStorage("kalshi_markets");
    let stopRequested = false;
    let forceStopRequested = false;
    let firstStopAt = 0;
    const FORCE_STOP_GRACE_MS = 1500;
    const onStopSignal = () => {
      if (!stopRequested) {
        stopRequested = true;
        firstStopAt = Date.now();
        console.warn(
          "Stop requested. Finishing current page, checkpointing cursor, then exiting. Press Ctrl+C again to force-exit.",
        );
        return;
      }
      if (Date.now() - firstStopAt < FORCE_STOP_GRACE_MS) {
        // bun run wrappers can forward duplicate SIGINT quickly; ignore immediate duplicate.
        return;
      }
      forceStopRequested = true;
      console.warn("Force stop requested. Exiting after current in-flight page.");
    };
    process.on("SIGINT", onStopSignal);
    process.on("SIGTERM", onStopSignal);

    try {
      const state = parseState(readCursor(STATE_FILE));
      const overlapSeconds = Math.max(0, Math.floor(OVERLAP_SECONDS));
      const logEvery = Math.max(1, Math.floor(PROGRESS_LOG_EVERY));
      const cursorLogEvery = Math.max(1, Math.floor(CURSOR_LOG_EVERY));
      const limit = Math.max(1, Math.floor(PAGE_LIMIT));
      const runMaxCreatedTs =
        RUN_MAX_CREATED_TS > 0 ? Math.floor(RUN_MAX_CREATED_TS) : undefined;
      const migrationLookbackSeconds = Math.max(0, Math.floor(MIGRATION_LOOKBACK_SECONDS));
      const nowTs = Math.floor(Date.now() / 1000);
      const maxWatermarkTs =
        nowTs + Math.max(0, Math.floor(WATERMARK_MAX_FUTURE_SECONDS));

      let cursor = state?.cursor ?? null;
      let watermarkCreatedTs = state?.watermarkCreatedTs ?? null;
      let maxSeenCreatedTs = state?.maxSeenCreatedTs ?? watermarkCreatedTs;

      if (state?.source === "close") {
        cursor = null;
        const maxCreated = await storage.queryScalar<string>(
          `SELECT MAX(created_time) AS v FROM {files}`,
        );
        const seededCreatedTs = toUnixSeconds(maxCreated != null ? String(maxCreated) : null);
        if (seededCreatedTs != null) {
          watermarkCreatedTs = Math.max(0, seededCreatedTs - migrationLookbackSeconds);
          maxSeenCreatedTs = watermarkCreatedTs;
        } else {
          watermarkCreatedTs = null;
          maxSeenCreatedTs = null;
        }
        const seededLabel =
          watermarkCreatedTs != null
            ? new Date(watermarkCreatedTs * 1000).toISOString()
            : "none";
        console.warn(
          `Migrating Kalshi markets state from close_time to created_time (cursor reset, seeded watermark=${seededLabel}, lookback=${migrationLookbackSeconds}s).`,
        );
      }

      if (watermarkCreatedTs == null) {
        const maxCreated = await storage.queryScalar<string>(
          `SELECT MAX(created_time) AS v FROM {files}`,
        );
        watermarkCreatedTs = toUnixSeconds(maxCreated != null ? String(maxCreated) : null);
        maxSeenCreatedTs = watermarkCreatedTs;
      }

      if (watermarkCreatedTs != null && watermarkCreatedTs > maxWatermarkTs) {
        const resetTs = Math.max(0, nowTs - overlapSeconds);
        console.warn(
          `Detected future created_time watermark ${new Date(watermarkCreatedTs * 1000).toISOString()} > allowed ${new Date(maxWatermarkTs * 1000).toISOString()}; resetting to ${new Date(resetTs * 1000).toISOString()}`,
        );
        watermarkCreatedTs = resetTs;
        maxSeenCreatedTs = resetTs;
        cursor = null;
      }

      let minCreatedTs =
        watermarkCreatedTs != null
          ? Math.max(0, watermarkCreatedTs - overlapSeconds)
          : undefined;

      const persist = (
        nextCursor: string | null,
        opts: { advanceWatermark?: boolean } = {},
      ): void => {
        if (opts.advanceWatermark && maxSeenCreatedTs != null) {
          watermarkCreatedTs = Math.max(watermarkCreatedTs ?? 0, maxSeenCreatedTs);
        }
        writeCursor(
          STATE_FILE,
          serializeState({
            version: "created_v1",
            cursor: nextCursor,
            watermarkCreatedTs,
            maxSeenCreatedTs: maxSeenCreatedTs ?? watermarkCreatedTs,
            updatedAt: new Date().toISOString(),
          }),
        );
      };

      if (cursor) {
        console.log(`Resuming from cursor: ${cursor.slice(0, 20)}...`);
      }
      if (minCreatedTs !== undefined) {
        console.log(
          `Incremental mode: fetching created_time >= ${new Date(minCreatedTs * 1000).toISOString()}`,
        );
      } else {
        console.log("No created-time watermark found, running full discovery crawl");
      }
      if (runMaxCreatedTs !== undefined) {
        console.log(
          `Run upper bound: created_time <= ${new Date(runMaxCreatedTs * 1000).toISOString()}`,
        );
      }

      let totalFetched = 0;
      let totalNew = 0;
      let pages = 0;
      let attemptedCursorRecovery = false;

      while (true) {
        try {
          for await (const { markets, cursor: nextCursor } of client.iterMarkets({
            limit,
            cursor,
            minCreatedTs,
            maxCreatedTs: runMaxCreatedTs,
          })) {
            pages++;
            totalFetched += markets.length;
            const fetchedAt = new Date().toISOString();
            const seenBatch = new Set<string>();
            const batchTickers: string[] = [];
            let pageMaxCreatedTs = maxSeenCreatedTs ?? watermarkCreatedTs ?? 0;

            for (const market of markets) {
              if (!seenBatch.has(market.ticker)) {
                seenBatch.add(market.ticker);
                batchTickers.push(market.ticker);
              }
              const createdTs = toUnixSeconds(market.created_time);
              if (createdTs != null) {
                const boundedCreatedTs = Math.min(createdTs, maxWatermarkTs);
                if (boundedCreatedTs > pageMaxCreatedTs) {
                  pageMaxCreatedTs = boundedCreatedTs;
                }
              }
            }

            if (pageMaxCreatedTs > (maxSeenCreatedTs ?? 0)) {
              maxSeenCreatedTs = pageMaxCreatedTs;
            }

            const existing = await storage.findExistingKeys("ticker", batchTickers);
            const newRecordsByTicker = new Map<string, Record<string, unknown>>();
            for (const market of markets) {
              if (existing.has(market.ticker)) continue;
              newRecordsByTicker.set(market.ticker, { ...market, _fetched_at: fetchedAt });
            }
            const newRecords = [...newRecordsByTicker.values()];

            if (newRecords.length > 0) {
              await storage.writeChunk(newRecords);
              totalNew += newRecords.length;
            }

            // Only commit durable watermark when a full pass reaches tail.
            // While cursor is still active, keep watermark conservative for safe fallback.
            persist(nextCursor, { advanceWatermark: !nextCursor });
            cursor = nextCursor;

            if (pages === 1 || pages % logEvery === 0 || !nextCursor) {
              console.log(
                `Page ${pages}: fetched ${markets.length}, new ${newRecords.length}, total fetched ${totalFetched}, total new ${totalNew}`,
              );
            }
            if (pages === 1 || pages % cursorLogEvery === 0 || !nextCursor) {
              console.log(
                `Cursor progress: page ${pages}, cursor_suffix=${cursorSuffix(nextCursor)}`,
              );
            }

            if (stopRequested || forceStopRequested) {
              console.warn("Graceful stop complete after checkpoint.");
              break;
            }
            if (!nextCursor) break;
          }
          if (stopRequested || forceStopRequested) break;
          break;
        } catch (err) {
          if (!attemptedCursorRecovery && cursor && isLikelyCursorError(err)) {
            attemptedCursorRecovery = true;
            console.warn(
              `Cursor-based fetch failed (${String(err)}). Falling back to watermark-only restart.`,
            );
            cursor = null;
            minCreatedTs =
              watermarkCreatedTs != null
                ? Math.max(0, watermarkCreatedTs - overlapSeconds)
                : undefined;
            persist(cursor, { advanceWatermark: false });
            continue;
          }
          throw err;
        }
      }

      console.log(
        `\nDiscovery complete: ${totalFetched} fetched, ${totalNew} new markets written`,
      );
    } catch (err) {
      console.error("Error during market indexing. State kept for resume.", err);
      throw err;
    } finally {
      process.off("SIGINT", onStopSignal);
      process.off("SIGTERM", onStopSignal);
      storage.close();
    }
  }
}
