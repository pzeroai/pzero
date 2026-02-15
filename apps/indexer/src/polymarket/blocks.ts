import { join } from "path";
import { Indexer } from "../common/indexer";
import { DATA_DIR as ROOT_DATA_DIR } from "../common/paths";
import { ParquetStorage } from "../common/storage";
import { PolygonClient, POLYMARKET_START_BLOCK } from "./blockchain";

const BLOCKS_DIR = join(ROOT_DATA_DIR, "polymarket/blocks");
const BUCKET_SIZE = 100_000;
const SAMPLE_INTERVAL = Number(process.env.PM_BLOCK_SAMPLE_INTERVAL || "20");
const MAX_WORKERS = 100;

export class PolymarketBlocksIndexer extends Indexer {
  constructor() {
    super("polymarket_blocks", "Fetches block timestamps and interpolates for every block");
  }

  private interpolate(
    sampled: [number, number][],
    _startBlock: number,
    _endBlock: number,
  ): Record<string, unknown>[] {
    const sorted = sampled.sort((a, b) => a[0] - b[0]);
    const records: Record<string, unknown>[] = [];

    for (let i = 0; i < sorted.length - 1; i++) {
      const [blockA, tsA] = sorted[i];
      const [blockB, tsB] = sorted[i + 1];
      const blockDiff = blockB - blockA;
      const tsDiff = tsB - tsA;

      for (let block = blockA; block < blockB; block++) {
        const offset = block - blockA;
        const ts = tsA + Math.floor((tsDiff * offset) / blockDiff);
        records.push({
          block_number: block,
          timestamp: new Date(ts * 1000).toISOString().replace(".000Z", "Z"),
        });
      }
    }

    // Add last block
    if (sorted.length > 0) {
      const [lastBlock, lastTs] = sorted[sorted.length - 1];
      records.push({
        block_number: lastBlock,
        timestamp: new Date(lastTs * 1000).toISOString().replace(".000Z", "Z"),
      });
    }

    return records;
  }

  async run(): Promise<void> {
    const { mkdirSync } = await import("fs");
    mkdirSync(BLOCKS_DIR, { recursive: true });

    const client = new PolygonClient();
    const storage = new ParquetStorage(BLOCKS_DIR, "blocks");
    try {
      const maxIndexed = await storage.getMaxValue("block_number");
      const lastIndexed = maxIndexed ?? 0;
      const latestBlock = await client.getBlockNumber();

      console.log(`Last indexed block: ${lastIndexed.toLocaleString()}`);
      console.log(`Latest chain block: ${latestBlock.toLocaleString()}`);

      const startBlock = maxIndexed != null ? maxIndexed + 1 : POLYMARKET_START_BLOCK;

      const blocksRemaining = latestBlock - startBlock + 1;
      console.log(`Blocks to fetch: ${blocksRemaining.toLocaleString()}`);

      if (blocksRemaining <= 0) {
        console.log("Already up to date");
        return;
      }

      let currentBucketStart = startBlock;
      while (currentBucketStart <= latestBlock) {
        const bucketEnd = Math.min(currentBucketStart + BUCKET_SIZE, latestBlock + 1);
        const interval = Math.max(1, Math.floor(SAMPLE_INTERVAL));

        // Build sample blocks
        const sampledBlocks: number[] = [];
        for (let b = currentBucketStart; b < bucketEnd; b += interval) {
          sampledBlocks.push(b);
        }
        if (sampledBlocks[sampledBlocks.length - 1] !== bucketEnd - 1) {
          sampledBlocks.push(bucketEnd - 1);
        }

        console.log(
          `\nFetching ${sampledBlocks.length.toLocaleString()} samples (every ${interval} blocks) for ${currentBucketStart.toLocaleString()} to ${(bucketEnd - 1).toLocaleString()}`,
        );

        // Fetch in parallel batches
        const sampled: [number, number][] = [];
        for (let i = 0; i < sampledBlocks.length; i += MAX_WORKERS) {
          const batch = sampledBlocks.slice(i, i + MAX_WORKERS);
          const results = await Promise.allSettled(
            batch.map(async (block) => {
              const ts = await client.getBlockTimestamp(block);
              return [block, ts] as [number, number];
            }),
          );
          for (const r of results) {
            if (r.status === "fulfilled") {
              sampled.push(r.value);
            } else {
              throw new Error(`Failed to fetch block timestamp: ${String(r.reason)}`);
            }
          }
          if ((i + MAX_WORKERS) % 500 === 0) {
            console.log(`  ...fetched ${Math.min(i + MAX_WORKERS, sampledBlocks.length)}/${sampledBlocks.length} samples`);
          }
        }

        if (sampled.length > 0) {
          const records = this.interpolate(sampled, currentBucketStart, bucketEnd);
          await storage.writeChunk(records);
          console.log(`Saved ${records.length} blocks`);
        }

        currentBucketStart = bucketEnd;
      }

      console.log("\nBlock indexing complete");
    } finally {
      storage.close();
    }
  }
}
