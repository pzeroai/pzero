import { join } from "path";
import { Indexer } from "../common/indexer";
import { DATA_DIR as ROOT_DATA_DIR } from "../common/paths";
import { ClickHouseStorage } from "../common/storage";
import { readCursor, writeCursor, deleteCursor } from "../common/cursor";
import { PolygonClient, FPMM_START_BLOCK } from "./blockchain";

const CURSOR_FILE = join(ROOT_DATA_DIR, "polymarket/.legacy_backfill_block_cursor");

export class PolymarketFPMMTradesIndexer extends Indexer {
  private chunkSize: number;
  private _maxWorkers: number;

  constructor(chunkSize = 1000, maxWorkers = 50) {
    super("polymarket_fpmm_trades", "Backfills Polymarket FPMM (AMM) trades from Polygon blockchain");
    this.chunkSize = chunkSize;
    this._maxWorkers = maxWorkers;
  }

  async run(): Promise<void> {
    const client = new PolygonClient();
    const storage = new ClickHouseStorage("polymarket_legacy_trades");
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
          fromBlock = FPMM_START_BLOCK;
        }
      }

      const toBlock = currentBlock;
      if (fromBlock > toBlock) {
        console.log(`Already up to date (next block ${fromBlock}, chain ${toBlock})`);
        return;
      }

      console.log(`Fetching FPMM trades from block ${fromBlock} to ${toBlock}`);
      console.log(`Total blocks: ${(toBlock - fromBlock + 1).toLocaleString()}`);

      let totalSaved = 0;
      let processed = 0;
      const totalChunks = Math.ceil((toBlock - fromBlock + 1) / this.chunkSize);

      for (let current = fromBlock; current <= toBlock; current += this.chunkSize) {
        const chunkEnd = Math.min(current + this.chunkSize - 1, toBlock);
        const fetchedAt = new Date().toISOString();
        const trades = await client.getFPMMTrades(current, chunkEnd);
        const chunkRecords = trades.map((trade) => ({ ...trade, _fetched_at: fetchedAt }));

        if (chunkRecords.length > 0) {
          await storage.writeChunk(chunkRecords);
          totalSaved += chunkRecords.length;
        }

        // Cursor stores next block and only advances after durable write.
        writeCursor(CURSOR_FILE, String(chunkEnd + 1));

        processed++;
        if (processed === 1 || processed % 50 === 0 || processed === totalChunks) {
          console.log(
            `[${processed}/${totalChunks}] block: ${chunkEnd}, chunk: ${chunkRecords.length}, saved: ${totalSaved}`,
          );
        }
      }

      deleteCursor(CURSOR_FILE);
      console.log(`\nFPMM backfill complete: ${totalSaved} trades saved`);
    } catch (err) {
      console.error("Error during indexing. Cursor kept for resume.", err);
      throw err;
    } finally {
      storage.close();
    }
  }
}
