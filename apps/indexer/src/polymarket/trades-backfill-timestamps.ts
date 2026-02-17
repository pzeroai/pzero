import duckdb from "duckdb";
import { readdirSync, renameSync, rmSync } from "fs";
import { join } from "path";
import { Indexer } from "../common/indexer";
import { DATA_DIR as ROOT_DATA_DIR } from "../common/paths";
import { deleteCursor, readCursor, writeCursor } from "../common/cursor";
import { PolygonClient } from "./blockchain";

const TRADES_DIR = join(ROOT_DATA_DIR, "polymarket/trades");
const BLOCKS_DIR = join(ROOT_DATA_DIR, "polymarket/blocks");
const BLOCKS_GLOB = join(ROOT_DATA_DIR, "polymarket/blocks/*.parquet");
const STATE_FILE = join(ROOT_DATA_DIR, "polymarket/.trades_timestamp_backfill_state.json");
const PROGRESS_LOG_EVERY = Number(process.env.PM_TRADES_TS_BACKFILL_LOG_EVERY || "100");
const RESET_STATE = process.env.PM_TRADES_TS_BACKFILL_RESET === "true";
const MAX_FILES_PER_RUN = Number(process.env.PM_TRADES_TS_BACKFILL_MAX_FILES || "0");
const FILE_CONCURRENCY = Number(process.env.PM_TRADES_TS_BACKFILL_FILE_CONCURRENCY || "4");
const RPC_FALLBACK_ENABLED = process.env.PM_TRADES_TS_BACKFILL_RPC_FALLBACK !== "false";
const RPC_FALLBACK_CONCURRENCY = Number(process.env.PM_TRADES_TS_BACKFILL_RPC_CONCURRENCY || "10");

interface BackfillState {
  nextIndex: number;
  rewritten: number;
  skipped: number;
  updatedAt: string;
}

function parseState(raw: string | null): BackfillState {
  if (!raw) {
    return {
      nextIndex: 0,
      rewritten: 0,
      skipped: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BackfillState>;
    return {
      nextIndex:
        typeof parsed.nextIndex === "number" && Number.isFinite(parsed.nextIndex) && parsed.nextIndex >= 0
          ? Math.floor(parsed.nextIndex)
          : 0,
      rewritten:
        typeof parsed.rewritten === "number" && Number.isFinite(parsed.rewritten) && parsed.rewritten >= 0
          ? Math.floor(parsed.rewritten)
          : 0,
      skipped:
        typeof parsed.skipped === "number" && Number.isFinite(parsed.skipped) && parsed.skipped >= 0
          ? Math.floor(parsed.skipped)
          : 0,
      updatedAt:
        typeof parsed.updatedAt === "string" && parsed.updatedAt.length > 0
          ? parsed.updatedAt
          : new Date(0).toISOString(),
    };
  } catch {
    return {
      nextIndex: 0,
      rewritten: 0,
      skipped: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }
}

function serializeState(state: BackfillState): string {
  return JSON.stringify({
    nextIndex: state.nextIndex,
    rewritten: state.rewritten,
    skipped: state.skipped,
    updatedAt: state.updatedAt,
  } satisfies BackfillState);
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function toIsoSecond(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toISOString().replace(".000Z", "Z");
}

function tradeFileStartIndex(fileName: string): number {
  const match = fileName.match(/^trades_(\d+)_/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function listTradeFiles(): string[] {
  return readdirSync(TRADES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".parquet"))
    .filter((name) => !name.startsWith("._"))
    .sort((a, b) => {
      const aStart = tradeFileStartIndex(a);
      const bStart = tradeFileStartIndex(b);
      if (aStart !== bStart) return aStart - bStart;
      return a.localeCompare(b);
    });
}

function countBlockFiles(): number {
  try {
    return readdirSync(BLOCKS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(".parquet"))
      .filter((name) => !name.startsWith("._"))
      .length;
  } catch {
    return 0;
  }
}

class BackfillDuckDB {
  private db: duckdb.Database;
  private conn: duckdb.Connection;

  constructor() {
    this.db = new duckdb.Database(":memory:");
    this.conn = this.db.connect();
  }

  query(sql: string): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.conn as any).all(sql, (err: Error | null, rows: Record<string, unknown>[]) => {
        if (err) reject(err);
        else resolve(rows ?? []);
      });
    });
  }

  async queryScalarNumber(sql: string): Promise<number> {
    const rows = await this.query(sql);
    if (rows.length === 0) return 0;
    const value = Object.values(rows[0])[0];
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "number") return value;
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  close(): void {
    // Intentionally skip explicit close() to avoid Bun+DuckDB NAPI crashes during teardown.
  }
}

interface BackfillFileResult {
  index: number;
  fileName: string;
  status: "rewritten" | "skipped";
  missingBefore?: number;
  rpcFetchedBlocks?: number;
  missingAfter?: number;
}

interface BackfillFileOptions {
  rpcFallbackEnabled: boolean;
  rpcFallbackConcurrency: number;
  getRpcClient: () => PolygonClient;
}

async function fetchBlockTimestampsFromRpc(
  client: PolygonClient,
  blockNumbers: number[],
  concurrency: number,
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (blockNumbers.length === 0) return result;

  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), blockNumbers.length);
  let nextIndex = 0;
  const workers: Promise<void>[] = [];

  for (let i = 0; i < workerCount; i++) {
    workers.push((async () => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= blockNumbers.length) break;
        const blockNumber = blockNumbers[idx];
        const ts = await client.getBlockTimestamp(blockNumber);
        result.set(blockNumber, toIsoSecond(ts));
      }
    })());
  }

  await Promise.all(workers);
  return result;
}

async function backfillTradeFile(
  fileName: string,
  index: number,
  opts: BackfillFileOptions,
): Promise<BackfillFileResult> {
  const db = new BackfillDuckDB();
  const filePath = join(TRADES_DIR, fileName);
  const tmpPath = `${filePath}.tmp`;
  const fileSql = sqlQuote(filePath);
  const tmpSql = sqlQuote(tmpPath);
  const blocksSql = sqlQuote(BLOCKS_GLOB);

  try {
    let hasTimestampColumn = false;
    try {
      await db.query(`SELECT timestamp FROM read_parquet(${fileSql}, union_by_name=true) LIMIT 1`);
      hasTimestampColumn = true;
    } catch {
      hasTimestampColumn = false;
    }

    if (hasTimestampColumn) {
      const missingExisting = await db.queryScalarNumber(
        `SELECT COUNT(*) AS c
         FROM read_parquet(${fileSql}, union_by_name=true)
         WHERE timestamp IS NULL OR CAST(timestamp AS VARCHAR) = ''`,
      );
      if (missingExisting === 0) {
        return { index, fileName, status: "skipped" };
      }
    }

    const missingBlockRows = await db.query(
      `WITH src AS (
         SELECT block_number FROM read_parquet(${fileSql}, union_by_name=true)
       ),
       needed_blocks AS (
         SELECT DISTINCT block_number FROM src
       )
       SELECT nb.block_number AS block_number
       FROM needed_blocks nb
       LEFT JOIN read_parquet(${blocksSql}, union_by_name=true) b
         ON b.block_number = nb.block_number
       WHERE b.block_number IS NULL`,
    );
    const missingBlockNumbers = missingBlockRows
      .map((row) => Number(row.block_number))
      .filter((n) => Number.isFinite(n));
    const missingBefore = missingBlockNumbers.length;

    let rpcFetchedBlocks = 0;
    let rpcBlockMapValuesSql = "";
    if (missingBlockNumbers.length > 0 && opts.rpcFallbackEnabled) {
      const rpcTimestamps = await fetchBlockTimestampsFromRpc(
        opts.getRpcClient(),
        missingBlockNumbers,
        opts.rpcFallbackConcurrency,
      );
      rpcFetchedBlocks = rpcTimestamps.size;
      if (rpcFetchedBlocks > 0) {
        const rpcRows = [...rpcTimestamps.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([blockNumber, timestamp]) => `(${blockNumber}, ${sqlQuote(timestamp)})`);
        rpcBlockMapValuesSql = rpcRows.join(", ");
      }
    }

    rmSync(tmpPath, { force: true });

    const rpcBlockMapCte = rpcBlockMapValuesSql.length > 0
      ? `,
           rpc_block_map AS (
             SELECT * FROM (VALUES ${rpcBlockMapValuesSql}) AS v(block_number, timestamp)
           )`
      : "";
    const blockMapSource = rpcBlockMapValuesSql.length > 0
      ? `SELECT b.block_number, b.timestamp
           FROM read_parquet(${blocksSql}, union_by_name=true) b
           INNER JOIN needed_blocks nb ON b.block_number = nb.block_number
           UNION ALL
           SELECT rb.block_number, rb.timestamp
           FROM rpc_block_map rb`
      : `SELECT b.block_number, b.timestamp
           FROM read_parquet(${blocksSql}, union_by_name=true) b
           INNER JOIN needed_blocks nb ON b.block_number = nb.block_number`;

    const backfillSql = hasTimestampColumn
      ? `COPY (
           WITH src AS (
             SELECT * FROM read_parquet(${fileSql}, union_by_name=true)
           ),
           needed_blocks AS (
             SELECT DISTINCT block_number FROM src
           )${rpcBlockMapCte},
           block_map AS (
             SELECT block_number, ANY_VALUE(timestamp) AS timestamp
             FROM (
               ${blockMapSource}
             ) mapped
             GROUP BY 1
           )
           SELECT
             src.* EXCLUDE (timestamp),
             COALESCE(CAST(src.timestamp AS VARCHAR), block_map.timestamp) AS timestamp
           FROM src
           LEFT JOIN block_map ON src.block_number = block_map.block_number
         ) TO ${tmpSql} (FORMAT PARQUET, COMPRESSION ZSTD)`
      : `COPY (
           WITH src AS (
             SELECT * FROM read_parquet(${fileSql}, union_by_name=true)
           ),
           needed_blocks AS (
             SELECT DISTINCT block_number FROM src
           )${rpcBlockMapCte},
           block_map AS (
             SELECT block_number, ANY_VALUE(timestamp) AS timestamp
             FROM (
               ${blockMapSource}
             ) mapped
             GROUP BY 1
           )
           SELECT
             src.*,
             block_map.timestamp AS timestamp
           FROM src
           LEFT JOIN block_map ON src.block_number = block_map.block_number
         ) TO ${tmpSql} (FORMAT PARQUET, COMPRESSION ZSTD)`;

    await db.query(backfillSql);

    const rowCountBefore = await db.queryScalarNumber(
      `SELECT COUNT(*) AS c FROM read_parquet(${fileSql}, union_by_name=true)`,
    );
    const rowCountAfter = await db.queryScalarNumber(
      `SELECT COUNT(*) AS c FROM read_parquet(${tmpSql}, union_by_name=true)`,
    );
    if (rowCountBefore !== rowCountAfter) {
      rmSync(tmpPath, { force: true });
      throw new Error(
        `Row count mismatch while backfilling ${fileName}: before=${rowCountBefore}, after=${rowCountAfter}`,
      );
    }

    const missingAfter = await db.queryScalarNumber(
      `SELECT COUNT(*) AS c
       FROM read_parquet(${tmpSql}, union_by_name=true)
       WHERE timestamp IS NULL OR CAST(timestamp AS VARCHAR) = ''`,
    );

    renameSync(tmpPath, filePath);
    return {
      index,
      fileName,
      status: "rewritten",
      missingBefore,
      rpcFetchedBlocks,
      missingAfter,
    };
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  } finally {
    db.close();
  }
}

export class PolymarketTradesTimestampBackfillIndexer extends Indexer {
  constructor() {
    super(
      "polymarket_trades_backfill_timestamps",
      "Backfills PM trade timestamp column from existing indexed block timestamps",
    );
  }

  async run(): Promise<void> {
    if (RESET_STATE) {
      deleteCursor(STATE_FILE);
      console.log("Reset timestamp-backfill state");
    }

    const files = listTradeFiles();
    if (files.length === 0) {
      console.log("No Polymarket trade parquet files found; nothing to backfill");
      return;
    }
    const blockFileCount = countBlockFiles();
    if (blockFileCount === 0) {
      throw new Error(
        `No Polymarket block parquet files found at ${BLOCKS_DIR}. Run polymarket_blocks first or provide block data before backfill.`,
      );
    }

    const logEvery = Math.max(1, Math.floor(PROGRESS_LOG_EVERY));
    const maxFilesPerRun = Math.max(0, Math.floor(MAX_FILES_PER_RUN));
    const fileConcurrency = Math.max(1, Math.floor(FILE_CONCURRENCY));
    const rpcFallbackConcurrency = Math.max(1, Math.floor(RPC_FALLBACK_CONCURRENCY));
    const state = parseState(readCursor(STATE_FILE));
    if (state.nextIndex >= files.length) {
      console.log(
        `Backfill already complete: files=${files.length}, rewritten=${state.rewritten}, skipped=${state.skipped}`,
      );
      return;
    }
    const runEndExclusive =
      maxFilesPerRun > 0 ? Math.min(files.length, state.nextIndex + maxFilesPerRun) : files.length;

    let rewritten = state.rewritten;
    let skipped = state.skipped;
    let rpcFetchedBlocksTotal = 0;
    let rpcClient: PolygonClient | null = null;
    const getRpcClient = (): PolygonClient => {
      if (!rpcClient) rpcClient = new PolygonClient();
      return rpcClient;
    };

    const persist = (nextIndex: number) => {
      writeCursor(
        STATE_FILE,
        serializeState({
          nextIndex,
          rewritten,
          skipped,
          updatedAt: new Date().toISOString(),
        }),
      );
    };

    try {
      console.log(
        `Backfilling PM trade timestamps from blocks parquet: files=${files.length}, starting_index=${state.nextIndex}, run_limit=${runEndExclusive - state.nextIndex}, file_concurrency=${fileConcurrency}, rpc_fallback=${RPC_FALLBACK_ENABLED}, rpc_concurrency=${rpcFallbackConcurrency}`,
      );

      for (let batchStart = state.nextIndex; batchStart < runEndExclusive; batchStart += fileConcurrency) {
        const batchEnd = Math.min(runEndExclusive, batchStart + fileConcurrency);
        const batchIndices: number[] = [];
        for (let i = batchStart; i < batchEnd; i++) {
          batchIndices.push(i);
        }

        const settled = await Promise.allSettled(
          batchIndices.map(async (i) =>
            backfillTradeFile(files[i], i, {
              rpcFallbackEnabled: RPC_FALLBACK_ENABLED,
              rpcFallbackConcurrency,
              getRpcClient,
            }),
          ),
        );

        const failed = settled.find((result) => result.status === "rejected");
        if (failed && failed.status === "rejected") {
          throw new Error(
            `Timestamp backfill batch ${batchStart}-${batchEnd - 1} failed: ${String(failed.reason)}`,
          );
        }

        const results = settled
          .filter((result): result is PromiseFulfilledResult<BackfillFileResult> => result.status === "fulfilled")
          .map((result) => result.value)
          .sort((a, b) => a.index - b.index);

        for (const result of results) {
          if (result.status === "skipped") {
            skipped++;
          } else {
            rewritten++;
            rpcFetchedBlocksTotal += result.rpcFetchedBlocks ?? 0;
          }
          const current = result.index + 1;
          if (
            current % logEvery === 0 ||
            current === runEndExclusive ||
            (result.status === "rewritten" && (result.missingAfter ?? 0) > 0)
          ) {
            if (result.status === "rewritten") {
              console.log(
                `[${current}/${files.length}] ${result.fileName}: rewritten, missing_before=${result.missingBefore ?? 0}, rpc_fetched=${result.rpcFetchedBlocks ?? 0}, missing_after=${result.missingAfter ?? 0}, skipped=${skipped}, rewritten=${rewritten}`,
              );
            } else {
              console.log(
                `[${current}/${files.length}] ${result.fileName}: already has timestamps (skipped=${skipped}, rewritten=${rewritten})`,
              );
            }
          }
        }

        // Batch checkpoint: if any worker in this batch fails, we do not advance state for the batch.
        // Successful files are idempotent and will be skipped on retry.
        persist(batchEnd);
      }

      console.log(
        `Timestamp backfill run complete: processed=${runEndExclusive - state.nextIndex}, total_files=${files.length}, rewritten=${rewritten}, skipped=${skipped}, rpc_fetched_blocks=${rpcFetchedBlocksTotal}`,
      );
    } catch (err) {
      console.error("Timestamp backfill failed. State kept for resume.", err);
      throw err;
    }
  }
}
