import { join } from "path";
import { Indexer } from "../common/indexer";
import { DATA_DIR as ROOT_DATA_DIR } from "../common/paths";
import { ClickHouseStorage } from "../common/storage";
import { readCursor, writeCursor, deleteCursor } from "../common/cursor";
import { PolygonClient, CTF_EXCHANGE, NEGRISK_CTF_EXCHANGE, POLYMARKET_START_BLOCK } from "./blockchain";

const CURSOR_FILE = join(ROOT_DATA_DIR, "polymarket/.backfill_block_cursor");
const FETCH_CONCURRENCY = Number(process.env.PM_TRADES_FETCH_CONCURRENCY || "4");
const CHUNK_SIZE = Number(process.env.PM_TRADES_CHUNK_SIZE || "1000");
const PROGRESS_LOG_EVERY = Number(process.env.PM_TRADES_PROGRESS_LOG_EVERY || "1");
const STALL_HEARTBEAT_MS = Number(process.env.PM_TRADES_STALL_HEARTBEAT_MS || "30000");
const BLOCK_TS_FETCH_CONCURRENCY = Number(process.env.PM_TRADES_BLOCK_TS_FETCH_CONCURRENCY || "20");

function toIsoSecond(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toISOString().replace(".000Z", "Z");
}

export class PolymarketTradesIndexer extends Indexer {
  private chunkSize: number;

  constructor(chunkSize = CHUNK_SIZE) {
    super("polymarket_trades", "Backfills Polymarket trades from Polygon blockchain to ClickHouse");
    this.chunkSize = Math.max(1, Math.floor(chunkSize));
  }

  async run(): Promise<void> {
    const client = new PolygonClient();
    const storage = new ClickHouseStorage("polymarket_trades");
    try {
      const currentBlock = await client.getBlockNumber();

      // Determine start block: durable cursor (next block) > existing data > default
      const saved = readCursor(CURSOR_FILE);
      let fromBlock: number;
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!Number.isFinite(parsed)) {
          throw new Error(`Invalid cursor value in ${CURSOR_FILE}: ${saved}`);
        }
        fromBlock = parsed;
        console.log(`Resuming from cursor: next block ${fromBlock}`);
      } else {
        const maxBlock = await storage.getMaxValue("block_number");
        if (maxBlock != null) {
          fromBlock = maxBlock + 1;
          console.log(`Resuming from existing data: next block ${fromBlock}`);
        } else {
          fromBlock = POLYMARKET_START_BLOCK;
        }
      }

      const toBlock = currentBlock;
      if (fromBlock > toBlock) {
        console.log(`Already up to date (next block ${fromBlock}, chain ${toBlock})`);
        return;
      }

      console.log(`Fetching trades from block ${fromBlock} to ${toBlock}`);
      console.log(`Total blocks: ${(toBlock - fromBlock + 1).toLocaleString()}`);
      const concurrency = Math.max(1, Math.floor(FETCH_CONCURRENCY));
      console.log(
        `Chunk fetch settings: chunkSize=${this.chunkSize}, concurrency=${concurrency}, logEvery=${Math.max(1, Math.floor(PROGRESS_LOG_EVERY))}`,
      );
      const logEvery = Math.max(1, Math.floor(PROGRESS_LOG_EVERY));
      const stallHeartbeatMs = Math.max(1000, Math.floor(STALL_HEARTBEAT_MS));

      let totalSaved = 0;
      let chunksProcessed = 0;
      const totalChunks = Math.ceil((toBlock - fromBlock + 1) / this.chunkSize);
      const ranges: [number, number][] = [];
      for (let current = fromBlock; current <= toBlock; current += this.chunkSize) {
        const chunkEnd = Math.min(current + this.chunkSize - 1, toBlock);
        ranges.push([current, chunkEnd]);
      }

      type ChunkFetchResult = {
        index: number;
        start: number;
        end: number;
        chunkRecords: Record<string, unknown>[];
        uniqueBlockCount: number;
        timestampFetchMs: number;
      };
      type ChunkCompletion =
        | { ok: true; value: ChunkFetchResult }
        | { ok: false; index: number; error: unknown };

      const inFlight = new Map<number, Promise<ChunkCompletion>>();
      const chunkStartedAt = new Map<number, number>();
      const ready = new Map<number, ChunkFetchResult>();
      const failures = new Map<number, unknown>();
      let nextToLaunch = 0;
      let nextToCommit = 0;

      const launch = (index: number) => {
        const [start, end] = ranges[index];
        const task = (async (): Promise<ChunkCompletion> => {
          try {
            const fetchedAt = new Date().toISOString();
            const [ctfTrades, negriskTrades] = await Promise.all([
              client.getOrderFilledTrades(start, end, CTF_EXCHANGE),
              client.getOrderFilledTrades(start, end, NEGRISK_CTF_EXCHANGE),
            ]);

            const allTrades = [...ctfTrades, ...negriskTrades];
            const uniqueBlocks = [...new Set(allTrades.map((trade) => trade.block_number))];
            const timestampsByBlock = new Map<number, string>();
            const tsFetchStartedAt = Date.now();

            if (uniqueBlocks.length > 0) {
              const blockTsConcurrency = Math.max(1, Math.floor(BLOCK_TS_FETCH_CONCURRENCY));
              let nextBlockIndex = 0;

              const workers: Promise<void>[] = [];
              const workerCount = Math.min(blockTsConcurrency, uniqueBlocks.length);
              for (let i = 0; i < workerCount; i++) {
                workers.push((async () => {
                  while (true) {
                    const idx = nextBlockIndex++;
                    if (idx >= uniqueBlocks.length) break;
                    const blockNumber = uniqueBlocks[idx];
                    const ts = await client.getBlockTimestamp(blockNumber);
                    timestampsByBlock.set(blockNumber, toIsoSecond(ts));
                  }
                })());
              }
              await Promise.all(workers);
            }

            const timestampFetchMs = Date.now() - tsFetchStartedAt;
            const chunkRecords: Record<string, unknown>[] = [];
            for (const trade of ctfTrades) {
              const timestamp = timestampsByBlock.get(trade.block_number);
              if (!timestamp) {
                throw new Error(
                  `Missing timestamp for block ${trade.block_number} in chunk ${start}-${end}`,
                );
              }
              chunkRecords.push({
                ...trade,
                timestamp,
                _fetched_at: fetchedAt,
                _contract: "CTF Exchange",
              });
            }
            for (const trade of negriskTrades) {
              const timestamp = timestampsByBlock.get(trade.block_number);
              if (!timestamp) {
                throw new Error(
                  `Missing timestamp for block ${trade.block_number} in chunk ${start}-${end}`,
                );
              }
              chunkRecords.push({
                ...trade,
                timestamp,
                _fetched_at: fetchedAt,
                _contract: "NegRisk CTF Exchange",
              });
            }

            return {
              ok: true,
              value: {
                index,
                start,
                end,
                chunkRecords,
                uniqueBlockCount: uniqueBlocks.length,
                timestampFetchMs,
              },
            };
          } catch (error) {
            return { ok: false, index, error };
          }
        })();

        chunkStartedAt.set(index, Date.now());
        inFlight.set(index, task);
      };

      while (nextToLaunch < ranges.length && inFlight.size < concurrency) {
        launch(nextToLaunch);
        nextToLaunch++;
      }

      while (inFlight.size > 0 || ready.has(nextToCommit)) {
        while (ready.has(nextToCommit)) {
          const { end, chunkRecords, uniqueBlockCount, timestampFetchMs } = ready.get(nextToCommit)!;
          ready.delete(nextToCommit);

          if (chunkRecords.length > 0) {
            await storage.writeChunk(chunkRecords);
            totalSaved += chunkRecords.length;
          }

          // Cursor stores the next block to process and only advances after durable write.
          writeCursor(CURSOR_FILE, String(end + 1));

          chunksProcessed++;
          if (
            chunksProcessed === 1 ||
            chunksProcessed % logEvery === 0 ||
            chunksProcessed === totalChunks
          ) {
            console.log(
              `[${chunksProcessed}/${totalChunks}] block: ${end}, chunk: ${chunkRecords.length}, blocks: ${uniqueBlockCount}, tsFetchMs: ${timestampFetchMs}, saved: ${totalSaved}`,
            );
          }

          nextToCommit++;
        }

        if (failures.has(nextToCommit)) {
          const [start, end] = ranges[nextToCommit];
          throw new Error(
            `Failed chunk ${start}-${end}: ${String(failures.get(nextToCommit))}`,
          );
        }

        if (inFlight.size === 0) break;

        let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
        const heartbeatPromise = new Promise<{ heartbeat: true }>((resolve) => {
          heartbeatTimer = setTimeout(() => resolve({ heartbeat: true }), stallHeartbeatMs);
        });
        const completion = await Promise.race<ChunkCompletion | { heartbeat: true }>([
          ...inFlight.values(),
          heartbeatPromise,
        ]);
        if (heartbeatTimer) clearTimeout(heartbeatTimer);

        if ("heartbeat" in completion) {
          const nextRange = ranges[nextToCommit];
          let oldestIndex: number | null = null;
          let oldestStartedAt = Number.POSITIVE_INFINITY;
          for (const [idx, startedAt] of chunkStartedAt) {
            if (startedAt < oldestStartedAt) {
              oldestStartedAt = startedAt;
              oldestIndex = idx;
            }
          }
          const oldestSec =
            oldestIndex != null ? Math.floor((Date.now() - oldestStartedAt) / 1000) : 0;
          const nextLabel = nextRange ? `${nextRange[0]}-${nextRange[1]}` : "n/a";
          const oldestLabel =
            oldestIndex != null
              ? `chunk ${oldestIndex + 1}/${totalChunks} running ${oldestSec}s`
              : "n/a";
          console.log(
            `Waiting for next commit chunk ${nextToCommit + 1}/${totalChunks} (${nextLabel}); inFlight=${inFlight.size}, ready=${ready.size}, oldest=${oldestLabel}`,
          );
          continue;
        }

        const completedIndex = completion.ok ? completion.value.index : completion.index;
        inFlight.delete(completedIndex);
        chunkStartedAt.delete(completedIndex);

        if (completion.ok) {
          ready.set(completion.value.index, completion.value);
        } else {
          failures.set(completion.index, completion.error);
        }

        while (nextToLaunch < ranges.length && inFlight.size < concurrency) {
          launch(nextToLaunch);
          nextToLaunch++;
        }
      }

      deleteCursor(CURSOR_FILE);
      console.log(`\nBackfill complete: ${totalSaved} trades saved`);
    } catch (err) {
      console.error("Error during indexing. Cursor kept for resume.", err);
      throw err;
    } finally {
      storage.close();
    }
  }
}
