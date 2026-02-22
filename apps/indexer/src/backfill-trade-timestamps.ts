import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { PolygonClient } from "./polymarket/blockchain";

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://localhost:8123";
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || "default";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || "";
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE || "default";
const RPC_FALLBACK_CONCURRENCY = Number(process.env.PM_TRADES_TS_BACKFILL_RPC_CONCURRENCY || "20");
const RPC_MISSING_BLOCK_WINDOW_SIZE = Number(process.env.PM_TRADES_TS_BACKFILL_RPC_MISSING_BLOCK_WINDOW_SIZE || "50000");
const UPDATE_BLOCK_WINDOW_SIZE = Number(process.env.PM_TRADES_TS_BACKFILL_UPDATE_BLOCK_WINDOW_SIZE || "50000");
const STEP_PROGRESS_LOG_MS = Number(process.env.PM_TRADES_TS_BACKFILL_STEP_PROGRESS_LOG_MS || "30000");
const JOIN_READY_TIMEOUT_MS = Number(process.env.PM_TRADES_TS_BACKFILL_JOIN_READY_TIMEOUT_MS || "30000");
const JOIN_READY_RETRY_MS = Number(process.env.PM_TRADES_TS_BACKFILL_JOIN_READY_RETRY_MS || "250");
const JOIN_BUILD_MAX_ATTEMPTS = Number(process.env.PM_TRADES_TS_BACKFILL_JOIN_BUILD_MAX_ATTEMPTS || "5");
const JOIN_BUILD_RETRY_MS = Number(process.env.PM_TRADES_TS_BACKFILL_JOIN_BUILD_RETRY_MS || "500");
const WINDOW_UPDATE_MAX_ATTEMPTS = Number(process.env.PM_TRADES_TS_BACKFILL_WINDOW_UPDATE_MAX_ATTEMPTS || "5");
const WINDOW_UPDATE_RETRY_MS = Number(process.env.PM_TRADES_TS_BACKFILL_WINDOW_UPDATE_RETRY_MS || "500");
const WINDOW_JOIN_TABLE = `pm_blocks_join_backfill_${process.pid}`;
const MISSING_TIMESTAMP_WHERE = "timestamp IS NULL OR timestamp = ''";

interface CliOptions {
  rpcFallback: boolean;
  dryRun: boolean;
}

interface MissingBlockRow {
  block_number: number | string;
}

interface CountRow {
  c: number | string;
}

interface BlockRangeRow {
  min_block: number | string | null;
  max_block: number | string | null;
}

interface WindowBackfillStats {
  totalWindows: number;
  windowsWithMissingRows: number;
  windowsUpdated: number;
}

function parseArgs(argv: string[]): CliOptions {
  return {
    rpcFallback: !argv.includes("--no-rpc-fallback"),
    dryRun: argv.includes("--dry-run"),
  };
}

function toIsoSecond(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toISOString().replace(".000Z", "Z");
}

function toNumber(value: number | string): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toPositiveInt(value: number, fallback: number, minValue: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minValue, Math.floor(value));
}

function formatDurationMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runStep<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  console.log(`[start] ${label}`);
  const progressIntervalMs = toPositiveInt(STEP_PROGRESS_LOG_MS, 30_000, 0);
  const ticker = progressIntervalMs > 0
    ? setInterval(() => {
      const elapsed = formatDurationMs(Date.now() - startedAt);
      console.log(`[progress] ${label} (elapsed=${elapsed})`);
    }, progressIntervalMs)
    : null;

  try {
    const result = await fn();
    const elapsed = formatDurationMs(Date.now() - startedAt);
    console.log(`[done] ${label} (elapsed=${elapsed})`);
    return result;
  } catch (err) {
    const elapsed = formatDurationMs(Date.now() - startedAt);
    console.error(`[error] ${label} failed (elapsed=${elapsed})`);
    throw err;
  } finally {
    if (ticker) clearInterval(ticker);
  }
}

async function fetchRows<T = Record<string, unknown>>(
  client: ClickHouseClient,
  query: string,
): Promise<T[]> {
  const result = await client.query({
    query,
    format: "JSONEachRow",
    clickhouse_settings: {
      wait_end_of_query: 1,
    },
  });
  return await result.json<T>();
}

async function fetchCount(client: ClickHouseClient, query: string): Promise<number> {
  const rows = await fetchRows<CountRow>(client, query);
  if (rows.length === 0) return 0;
  return toNumber(rows[0].c);
}

async function command(client: ClickHouseClient, query: string): Promise<void> {
  await client.command({
    query,
    clickhouse_settings: {
      wait_end_of_query: 1,
    },
  });
}

async function countMissingTradeTimestamps(client: ClickHouseClient): Promise<number> {
  return await fetchCount(
    client,
    `
      SELECT count() AS c
      FROM polymarket_trades
      WHERE ${MISSING_TIMESTAMP_WHERE}
    `,
  );
}

async function countMissingTradeTimestampsInRange(
  client: ClickHouseClient,
  minBlockInclusive: number,
  maxBlockExclusive: number,
): Promise<number> {
  return await fetchCount(
    client,
    `
      SELECT count() AS c
      FROM polymarket_trades
      WHERE (${MISSING_TIMESTAMP_WHERE})
        AND block_number >= ${minBlockInclusive}
        AND block_number < ${maxBlockExclusive}
    `,
  );
}

function isJoinNotInitializedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("NOT_INITIALIZED")
    || message.includes("WAITED_FOR_BACKEND_TABLE");
}

function quoteCompoundIdentifier(name: string): string {
  return name
    .split(".")
    .map((part) => `\`${part.replaceAll("`", "``")}\``)
    .join(".");
}

async function waitForJoinTableReady(
  client: ClickHouseClient,
  joinTableRef: string,
): Promise<void> {
  const timeoutMs = toPositiveInt(JOIN_READY_TIMEOUT_MS, 30_000, 0);
  const retryMs = toPositiveInt(JOIN_READY_RETRY_MS, 250, 50);
  const startedAt = Date.now();
  const joinTableIdent = quoteCompoundIdentifier(joinTableRef);
  let lastErrorMessage = "unknown initialization error";

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      await fetchRows(client, `SELECT 1 AS ok FROM ${joinTableIdent} LIMIT 1`);
      return;
    } catch (err) {
      if (!isJoinNotInitializedError(err)) throw err;
      lastErrorMessage = err instanceof Error ? err.message : String(err);
      await sleep(retryMs);
    }
  }

  throw new Error(
    `Join table ${joinTableRef} was not initialized within ${timeoutMs}ms: ${lastErrorMessage}`,
  );
}

async function fetchMissingTradeBlockRange(
  client: ClickHouseClient,
): Promise<{ min: number; max: number } | null> {
  const rows = await fetchRows<BlockRangeRow>(
    client,
    `
      SELECT
        min(block_number) AS min_block,
        max(block_number) AS max_block
      FROM polymarket_trades
      WHERE ${MISSING_TIMESTAMP_WHERE}
    `,
  );

  if (rows.length === 0) return null;
  const minBlock = rows[0].min_block === null ? null : toNumber(rows[0].min_block);
  const maxBlock = rows[0].max_block === null ? null : toNumber(rows[0].max_block);
  if (minBlock === null || maxBlock === null || minBlock <= 0 || maxBlock <= 0) {
    return null;
  }

  return { min: minBlock, max: maxBlock };
}

async function refreshWindowJoinTable(
  client: ClickHouseClient,
  minBlockInclusive: number,
  maxBlockExclusive: number,
): Promise<void> {
  const joinTableRef = `${CLICKHOUSE_DATABASE}.${WINDOW_JOIN_TABLE}`;
  const maxAttempts = toPositiveInt(JOIN_BUILD_MAX_ATTEMPTS, 5, 1);
  const baseRetryMs = toPositiveInt(JOIN_BUILD_RETRY_MS, 500, 50);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await command(client, `DROP TABLE IF EXISTS ${WINDOW_JOIN_TABLE}`);
      await command(
        client,
        `
          CREATE TABLE ${WINDOW_JOIN_TABLE}
          (
            block_number UInt64,
            timestamp String
          )
          ENGINE = Join(ANY, LEFT, block_number)
        `,
      );
      await waitForJoinTableReady(client, joinTableRef);
      await command(
        client,
        `
          INSERT INTO ${WINDOW_JOIN_TABLE} (block_number, timestamp)
          SELECT
            pb.block_number,
            any(pb.timestamp)
          FROM polymarket_blocks AS pb
          WHERE pb.timestamp != ''
            AND pb.block_number >= ${minBlockInclusive}
            AND pb.block_number < ${maxBlockExclusive}
          GROUP BY pb.block_number
        `,
      );
      await waitForJoinTableReady(client, joinTableRef);
      return;
    } catch (err) {
      if (!isJoinNotInitializedError(err) || attempt >= maxAttempts) {
        throw err;
      }
      const retryMs = baseRetryMs * attempt;
      console.warn(
        `Join table ${joinTableRef} not initialized for window ${minBlockInclusive}..${maxBlockExclusive - 1} (attempt ${attempt}/${maxAttempts}); retrying in ${retryMs}ms.`,
      );
      await sleep(retryMs);
    }
  }
}

async function applyTradeTimestampUpdateForWindow(
  client: ClickHouseClient,
  joinTableRef: string,
  minBlockInclusive: number,
  maxBlockExclusive: number,
): Promise<void> {
  const maxAttempts = toPositiveInt(WINDOW_UPDATE_MAX_ATTEMPTS, 5, 1);
  const baseRetryMs = toPositiveInt(WINDOW_UPDATE_RETRY_MS, 500, 50);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await command(
        client,
        `
          ALTER TABLE polymarket_trades
          UPDATE timestamp = nullIf(joinGet('${joinTableRef}', 'timestamp', block_number), '')
          WHERE (${MISSING_TIMESTAMP_WHERE})
            AND block_number >= ${minBlockInclusive}
            AND block_number < ${maxBlockExclusive}
            AND joinGet('${joinTableRef}', 'timestamp', block_number) != ''
          SETTINGS mutations_sync = 2
        `,
      );
      return;
    } catch (err) {
      if (!isJoinNotInitializedError(err) || attempt >= maxAttempts) {
        throw err;
      }
      const retryMs = baseRetryMs * attempt;
      console.warn(
        `joinGet update window ${minBlockInclusive}..${maxBlockExclusive - 1} hit NOT_INITIALIZED (attempt ${attempt}/${maxAttempts}); retrying in ${retryMs}ms.`,
      );
      await sleep(retryMs);
    }
  }
}

async function backfillFromExistingBlocksInWindows(
  client: ClickHouseClient,
): Promise<WindowBackfillStats> {
  const range = await fetchMissingTradeBlockRange(client);
  if (!range) {
    return {
      totalWindows: 0,
      windowsWithMissingRows: 0,
      windowsUpdated: 0,
    };
  }

  const windowSize = toPositiveInt(UPDATE_BLOCK_WINDOW_SIZE, 50_000, 1_000);
  const totalWindows = Math.max(1, Math.ceil((range.max - range.min + 1) / windowSize));
  const joinTableRef = `${CLICKHOUSE_DATABASE}.${WINDOW_JOIN_TABLE}`;

  let windowIndex = 0;
  let windowsWithMissingRows = 0;
  let windowsUpdated = 0;

  console.log(
    `Existing-block pass over missing range [${range.min}, ${range.max}] with window_size=${windowSize} (${totalWindows} windows)`,
  );

  for (let start = range.min; start <= range.max; start += windowSize) {
    windowIndex += 1;
    if (windowIndex % 50 === 0) {
      console.log(`Existing-block window progress: ${windowIndex}/${totalWindows}`);
    }

    const endExclusive = start + windowSize;
    const missingRows = await countMissingTradeTimestampsInRange(client, start, endExclusive);
    if (missingRows === 0) continue;
    windowsWithMissingRows += 1;

    await refreshWindowJoinTable(client, start, endExclusive);
    try {
      const joinRows = await fetchCount(
        client,
        `SELECT count() AS c FROM ${WINDOW_JOIN_TABLE}`,
      );
      if (joinRows === 0) continue;

      console.log(
        `Existing-block window ${windowIndex}/${totalWindows}: missing_rows=${missingRows}, join_rows=${joinRows}, range=${start}..${endExclusive - 1}`,
      );
      await applyTradeTimestampUpdateForWindow(client, joinTableRef, start, endExclusive);
      windowsUpdated += 1;
    } finally {
      try {
        await command(client, `DROP TABLE IF EXISTS ${WINDOW_JOIN_TABLE}`);
      } catch {
        // Best-effort cleanup between windows.
      }
    }
  }

  return {
    totalWindows,
    windowsWithMissingRows,
    windowsUpdated,
  };
}

async function fetchMissingBlocksInRange(
  client: ClickHouseClient,
  minBlockInclusive: number,
  maxBlockExclusive: number,
): Promise<number[]> {
  const result = await client.query({
    query: `
      SELECT t.block_number AS block_number
      FROM (
        SELECT block_number
        FROM polymarket_trades
        WHERE (${MISSING_TIMESTAMP_WHERE})
          AND block_number >= ${minBlockInclusive}
          AND block_number < ${maxBlockExclusive}
        GROUP BY block_number
      ) AS t
      LEFT JOIN (
        SELECT block_number
        FROM polymarket_blocks
        WHERE timestamp IS NOT NULL
          AND timestamp != ''
          AND block_number >= ${minBlockInclusive}
          AND block_number < ${maxBlockExclusive}
        GROUP BY block_number
      ) AS b
      ON t.block_number = b.block_number
      WHERE b.block_number IS NULL
    `,
    format: "JSONEachRow",
    clickhouse_settings: {
      wait_end_of_query: 1,
      max_bytes_before_external_group_by: "134217728",
      max_bytes_before_external_sort: "134217728",
    },
  });
  const rows = await result.json<MissingBlockRow>();

  return rows
    .map((row) => toNumber(row.block_number))
    .filter((n) => Number.isFinite(n) && n > 0);
}

async function backfillMissingBlocksFromRpc(
  client: ClickHouseClient,
  rpcConcurrency: number,
): Promise<{ missingBlockCount: number; insertedRowCount: number }> {
  const range = await fetchMissingTradeBlockRange(client);
  if (!range) {
    return { missingBlockCount: 0, insertedRowCount: 0 };
  }

  const windowSize = toPositiveInt(RPC_MISSING_BLOCK_WINDOW_SIZE, 50_000, 1_000);
  const totalWindows = Math.max(1, Math.ceil((range.max - range.min + 1) / windowSize));
  let windowIndex = 0;
  let missingBlockCount = 0;
  let insertedRowCount = 0;

  console.log(
    `Scanning missing block refs in range [${range.min}, ${range.max}] with window_size=${windowSize} (${totalWindows} windows)`,
  );

  for (let start = range.min; start <= range.max; start += windowSize) {
    windowIndex += 1;
    const endExclusive = start + windowSize;
    const missingBlocks = await fetchMissingBlocksInRange(client, start, endExclusive);
    if (missingBlocks.length === 0) {
      continue;
    }

    missingBlockCount += missingBlocks.length;
    console.log(
      `RPC window ${windowIndex}/${totalWindows}: fetching ${missingBlocks.length} block timestamps (range ${start}..${endExclusive - 1})`,
    );

    const records = await fetchBlockTimestampsFromRpc(missingBlocks, rpcConcurrency);
    if (records.length > 0) {
      await client.insert({
        table: "polymarket_blocks",
        values: records,
        format: "JSONEachRow",
        clickhouse_settings: {
          wait_end_of_query: 1,
        },
      });
      insertedRowCount += records.length;
    }
  }

  return { missingBlockCount, insertedRowCount };
}

async function fetchBlockTimestampsFromRpc(
  blockNumbers: number[],
  concurrency: number,
): Promise<Array<Record<string, unknown>>> {
  if (blockNumbers.length === 0) return [];

  const client = new PolygonClient();
  const workerCount = Math.min(
    Math.max(1, Math.floor(concurrency)),
    blockNumbers.length,
  );
  let next = 0;
  const fetchedAt = new Date().toISOString();
  const out: Array<Record<string, unknown>> = [];

  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push((async () => {
      while (true) {
        const idx = next++;
        if (idx >= blockNumbers.length) break;
        const blockNumber = blockNumbers[idx];
        const ts = await client.getBlockTimestamp(blockNumber);
        out.push({
          block_number: blockNumber,
          timestamp: toIsoSecond(ts),
          _fetched_at: fetchedAt,
        });
      }
    })());
  }
  await Promise.all(workers);

  out.sort((a, b) => Number(a.block_number) - Number(b.block_number));
  return out;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = createClient({
    url: CLICKHOUSE_URL,
    username: CLICKHOUSE_USER,
    password: CLICKHOUSE_PASSWORD,
    database: CLICKHOUSE_DATABASE,
  });
  const rpcConcurrency = toPositiveInt(RPC_FALLBACK_CONCURRENCY, 20, 1);

  try {
    console.log(
      `Backfilling polymarket_trades.timestamp (db=${CLICKHOUSE_DATABASE}, url=${CLICKHOUSE_URL}, rpc_fallback=${options.rpcFallback}, dry_run=${options.dryRun})`,
    );
    console.log(
      `Step progress logging interval: ${toPositiveInt(STEP_PROGRESS_LOG_MS, 30_000, 0)}ms (set PM_TRADES_TS_BACKFILL_STEP_PROGRESS_LOG_MS=0 to disable)`,
    );

    const missingBefore = await runStep(
      "Count missing timestamps before backfill",
      async () => await countMissingTradeTimestamps(client),
    );
    if (missingBefore === 0) {
      console.log("No missing timestamps in polymarket_trades; nothing to do.");
      return;
    }
    console.log(`Missing timestamp rows before backfill: ${missingBefore}`);

    const missingRange = await runStep(
      "Fetch missing trade block range",
      async () => await fetchMissingTradeBlockRange(client),
    );
    if (missingRange) {
      const updateWindowSize = toPositiveInt(UPDATE_BLOCK_WINDOW_SIZE, 50_000, 1_000);
      const updateWindows = Math.max(
        1,
        Math.ceil((missingRange.max - missingRange.min + 1) / updateWindowSize),
      );
      console.log(
        `Missing trade block range: [${missingRange.min}, ${missingRange.max}] with update_window_size=${updateWindowSize} (${updateWindows} windows)`,
      );
    }

    if (options.dryRun) {
      console.log("[dry-run] Skipping all mutations and RPC calls.");
      return;
    }

    console.log("Applying existing polymarket_blocks timestamps with windowed mutations.");
    const existingPassStats = await runStep(
      "Windowed update from existing block timestamps",
      async () => await backfillFromExistingBlocksInWindows(client),
    );
    console.log(
      `Existing-block pass stats: total_windows=${existingPassStats.totalWindows}, windows_with_missing_rows=${existingPassStats.windowsWithMissingRows}, windows_updated=${existingPassStats.windowsUpdated}`,
    );

    const missingAfterExisting = await runStep(
      "Count missing timestamps after existing-block pass",
      async () => await countMissingTradeTimestamps(client),
    );
    const updatedAfterExisting = Math.max(0, missingBefore - missingAfterExisting);
    console.log(`Rows updated in existing-block pass: ${updatedAfterExisting}`);
    console.log(`Missing timestamp rows after existing-block pass: ${missingAfterExisting}`);
    if (missingAfterExisting === 0) {
      console.log(
        `Backfill complete: updated=${missingBefore}, missing_before=${missingBefore}, missing_after=0`,
      );
      return;
    }

    if (!options.rpcFallback) {
      console.log(
        "RPC fallback disabled. Remaining rows will stay null unless missing block timestamps are inserted into polymarket_blocks.",
      );
      console.log(
        `Backfill complete: updated=${updatedAfterExisting}, missing_before=${missingBefore}, missing_after=${missingAfterExisting}`,
      );
      return;
    }

    const rpcResult = await runStep(
      "Fetch and insert missing block timestamps from Polygon RPC",
      async () => await backfillMissingBlocksFromRpc(client, rpcConcurrency),
    );
    console.log(
      `RPC pass complete: missing_block_refs=${rpcResult.missingBlockCount}, inserted=${rpcResult.insertedRowCount}`,
    );

    if (rpcResult.insertedRowCount > 0) {
      console.log("Applying RPC-fetched block timestamps with a second windowed mutation pass.");
      const secondPassStats = await runStep(
        "Windowed update from existing blocks after RPC insert",
        async () => await backfillFromExistingBlocksInWindows(client),
      );
      console.log(
        `Post-RPC existing-block pass stats: total_windows=${secondPassStats.totalWindows}, windows_with_missing_rows=${secondPassStats.windowsWithMissingRows}, windows_updated=${secondPassStats.windowsUpdated}`,
      );
    }

    const missingAfter = await runStep(
      "Count missing timestamps after full backfill",
      async () => await countMissingTradeTimestamps(client),
    );
    const updated = Math.max(0, missingBefore - missingAfter);
    console.log(
      `Backfill complete: updated=${updated}, missing_before=${missingBefore}, missing_after=${missingAfter}`,
    );
    if (missingAfter > 0) {
      console.log(
        "Rows still missing timestamps after RPC fallback. Check Polygon RPC coverage and data quality in polymarket_blocks.",
      );
    }
  } finally {
    try {
      await command(client, `DROP TABLE IF EXISTS ${WINDOW_JOIN_TABLE}`);
    } catch {
      // Best-effort cleanup.
    }
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
