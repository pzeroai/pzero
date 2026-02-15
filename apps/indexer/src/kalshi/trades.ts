import { join } from "path";
import { Indexer } from "../common/indexer";
import { DATA_DIR as ROOT_DATA_DIR } from "../common/paths";
import { ParquetStorage } from "../common/storage";
import { deleteCursor, readCursor, writeCursor } from "../common/cursor";
import { KalshiClient } from "./client";

const DATA_DIR = join(ROOT_DATA_DIR, "kalshi/trades");
const STATE_FILE = join(ROOT_DATA_DIR, "kalshi/.trades_state.json");
const LEGACY_CURSOR_FILE = join(ROOT_DATA_DIR, "kalshi/.backfill_trades_cursor");
const FLUSH_SIZE = Number(process.env.KALSHI_TRADES_FLUSH_SIZE || "10000");
const FLUSH_INTERVAL_MS = Number(process.env.KALSHI_TRADES_FLUSH_INTERVAL_MS || "30000");
const OVERLAP_SECONDS = Number(process.env.KALSHI_TRADES_OVERLAP_SECONDS || "120");
const PROGRESS_LOG_EVERY = Number(process.env.KALSHI_TRADES_PROGRESS_LOG_EVERY || "10");

interface KalshiTradesState {
  cursor: string | null;
  watermarkTs: number | null;
  maxSeenTs: number | null;
  updatedAt: string;
}

function parseState(raw: string | null): KalshiTradesState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<KalshiTradesState>;
    const cursor =
      typeof parsed.cursor === "string" && parsed.cursor.length > 0
        ? parsed.cursor
        : null;
    const watermarkTs =
      typeof parsed.watermarkTs === "number" &&
      Number.isFinite(parsed.watermarkTs) &&
      parsed.watermarkTs >= 0
        ? Math.floor(parsed.watermarkTs)
        : null;
    const maxSeenTs =
      typeof parsed.maxSeenTs === "number" &&
      Number.isFinite(parsed.maxSeenTs) &&
      parsed.maxSeenTs >= 0
        ? Math.floor(parsed.maxSeenTs)
        : watermarkTs;
    const updatedAt =
      typeof parsed.updatedAt === "string" && parsed.updatedAt.length > 0
        ? parsed.updatedAt
        : new Date(0).toISOString();
    return { cursor, watermarkTs, maxSeenTs, updatedAt };
  } catch {
    return null;
  }
}

function serializeState(state: KalshiTradesState): string {
  return JSON.stringify({
    cursor: state.cursor,
    watermarkTs: state.watermarkTs,
    maxSeenTs: state.maxSeenTs,
    updatedAt: state.updatedAt,
  } satisfies KalshiTradesState);
}

function toUnixSeconds(ts: string | null): number | null {
  if (!ts) return null;
  const ms = new Date(ts).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function isLikelyCursorError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return msg.includes("cursor") || msg.includes("invalid");
}

export class KalshiTradesIndexer extends Indexer {
  constructor() {
    super("kalshi_trades", "Backfills Kalshi trades via global trades endpoint");
  }

  async run(): Promise<void> {
    const client = new KalshiClient();
    const storage = new ParquetStorage(DATA_DIR, "trades");
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
        return;
      }
      forceStopRequested = true;
      console.warn("Force stop requested. Exiting after current in-flight page.");
    };
    process.on("SIGINT", onStopSignal);
    process.on("SIGTERM", onStopSignal);
    try {
      const runMaxTs = Math.floor(Date.now() / 1000);
      const overlapSeconds = Math.max(0, Math.floor(OVERLAP_SECONDS));
      const flushSize = Math.max(1, Math.floor(FLUSH_SIZE));
      const flushIntervalMs = Math.max(1000, Math.floor(FLUSH_INTERVAL_MS));
      const logEvery = Math.max(1, Math.floor(PROGRESS_LOG_EVERY));

      const state = parseState(readCursor(STATE_FILE));
      let cursor = state?.cursor ?? null;
      let watermarkTs = state?.watermarkTs ?? null;
      let maxSeenTs = state?.maxSeenTs ?? watermarkTs;

      if (watermarkTs == null) {
        const legacyCursor = readCursor(LEGACY_CURSOR_FILE);
        if (legacyCursor) {
          const parsed = parseInt(legacyCursor, 10);
          if (Number.isFinite(parsed) && parsed >= 0) {
            watermarkTs = parsed;
            maxSeenTs = parsed;
          }
        }
      }

      if (watermarkTs == null) {
        const maxCreatedTime = await storage.queryScalar<string>(
          `SELECT MAX(created_time) AS v FROM {files}`,
        );
        watermarkTs = toUnixSeconds(maxCreatedTime != null ? String(maxCreatedTime) : null);
        maxSeenTs = watermarkTs;
      }

      let minTs =
        watermarkTs != null
          ? Math.max(0, watermarkTs - overlapSeconds)
          : undefined;

      const persist = (
        nextCursor: string | null,
        opts: { advanceWatermark?: boolean } = {},
      ): void => {
        if (opts.advanceWatermark && maxSeenTs != null) {
          watermarkTs = Math.max(watermarkTs ?? 0, maxSeenTs);
        }
        writeCursor(
          STATE_FILE,
          serializeState({
            cursor: nextCursor,
            watermarkTs,
            maxSeenTs: maxSeenTs ?? watermarkTs,
            updatedAt: new Date().toISOString(),
          }),
        );
      };

      if (cursor) {
        console.log(`Resuming from cursor: ${cursor.slice(0, 20)}...`);
      }
      if (minTs !== undefined) {
        console.log(
          `Incremental mode: fetching trades with created_time >= ${new Date(minTs * 1000).toISOString()}`,
        );
      } else {
        console.log("No trade watermark found, running full discovery crawl");
      }
      console.log(`Run upper bound: created_time <= ${new Date(runMaxTs * 1000).toISOString()}`);
      console.log(
        `Flush settings: size=${flushSize}, intervalMs=${flushIntervalMs}, logEvery=${logEvery} pages`,
      );

      const pending: Record<string, unknown>[] = [];
      const pendingIds = new Set<string>();
      let totalFetched = 0;
      let totalNew = 0;
      let totalSaved = 0;
      let pages = 0;
      let lastFlushAt = Date.now();
      let attemptedCursorRecovery = false;
      let liveCursor = cursor;

      const flushPending = async (
        checkpointCursor: string | null,
        opts: { advanceWatermark?: boolean } = {},
      ): Promise<boolean> => {
        if (pending.length === 0) return false;
        const toWrite = pending.splice(0, pending.length);
        await storage.writeChunk(toWrite);
        pendingIds.clear();
        totalSaved += toWrite.length;
        lastFlushAt = Date.now();
        persist(checkpointCursor, opts);
        return true;
      };

      while (true) {
        try {
          for await (const { trades, cursor: nextCursor } of client.iterTrades({
            cursor: liveCursor,
            minTs,
            maxTs: runMaxTs,
          })) {
            pages++;
            totalFetched += trades.length;
            const fetchedAt = new Date().toISOString();
            let pageMaxTs = maxSeenTs ?? watermarkTs ?? 0;

            if (trades.length > 0) {
              const batchTradeIds = trades.map((t) => t.trade_id);
              const existing = await storage.findExistingKeys("trade_id", batchTradeIds);

              for (const trade of trades) {
                const tradeTs = toUnixSeconds(trade.created_time);
                if (tradeTs != null && tradeTs > pageMaxTs) {
                  pageMaxTs = tradeTs;
                }
                if (existing.has(trade.trade_id) || pendingIds.has(trade.trade_id)) continue;
                pendingIds.add(trade.trade_id);
                pending.push({ ...trade, _fetched_at: fetchedAt });
                totalNew++;
              }
            }

            if (pageMaxTs > (maxSeenTs ?? 0)) {
              maxSeenTs = pageMaxTs;
            }

            const nowMs = Date.now();
            const shouldFlushBySize = pending.length >= flushSize;
            const shouldFlushByTime =
              pending.length > 0 && nowMs - lastFlushAt >= flushIntervalMs;

            let flushed = false;
            if (shouldFlushBySize || shouldFlushByTime) {
              flushed = await flushPending(nextCursor, { advanceWatermark: !nextCursor });
            }

            liveCursor = nextCursor;

            // Cursor only advances durably when there is no unflushed data risk.
            if (!flushed && pending.length === 0) {
              persist(nextCursor, { advanceWatermark: !nextCursor });
            }

            if (pages === 1 || pages % logEvery === 0 || !nextCursor) {
              const lagSeconds = watermarkTs != null ? Math.max(0, runMaxTs - watermarkTs) : null;
              console.log(
                `Page ${pages}: fetched ${totalFetched.toLocaleString()}, new ${totalNew.toLocaleString()}, pending ${pending.length.toLocaleString()}, saved ${totalSaved.toLocaleString()}, lag ${lagSeconds ?? "n/a"}s`,
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
          if (!attemptedCursorRecovery && liveCursor && isLikelyCursorError(err)) {
            attemptedCursorRecovery = true;
            console.warn(
              `Cursor-based fetch failed (${String(err)}). Falling back to watermark-only restart.`,
            );
            liveCursor = null;
            minTs =
              watermarkTs != null
                ? Math.max(0, watermarkTs - overlapSeconds)
                : undefined;
            persist(liveCursor, { advanceWatermark: false });
            continue;
          }
          throw err;
        }
      }

      await flushPending(liveCursor, { advanceWatermark: !liveCursor });
      persist(liveCursor, { advanceWatermark: !liveCursor });
      deleteCursor(LEGACY_CURSOR_FILE);
      console.log(
        `\nBackfill complete: ${totalFetched.toLocaleString()} fetched, ${totalNew.toLocaleString()} new, ${totalSaved.toLocaleString()} saved`,
      );
    } catch (err) {
      console.error("Error during indexing. Cursor kept for resume.", err);
      throw err;
    } finally {
      process.off("SIGINT", onStopSignal);
      process.off("SIGTERM", onStopSignal);
      storage.close();
    }
  }
}
