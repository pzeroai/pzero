import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { PolygonClient } from "./polymarket/blockchain";

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://localhost:8123";
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || "default";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || "";
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE || "default";
const RPC_FALLBACK_CONCURRENCY = Number(process.env.PM_TRADES_TS_BACKFILL_RPC_CONCURRENCY || "20");
const STEP_PROGRESS_LOG_MS = Number(process.env.PM_TRADES_TS_BACKFILL_STEP_PROGRESS_LOG_MS || "30000");
const JOIN_READY_TIMEOUT_MS = Number(process.env.PM_TRADES_TS_BACKFILL_JOIN_READY_TIMEOUT_MS || "120000");
const JOIN_READY_RETRY_MS = Number(process.env.PM_TRADES_TS_BACKFILL_JOIN_READY_RETRY_MS || "500");
const BLOCKS_JOIN_TABLE = "pm_blocks_join_backfill";
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
  const progressIntervalMs = Number.isFinite(STEP_PROGRESS_LOG_MS)
    ? Math.max(0, Math.floor(STEP_PROGRESS_LOG_MS))
    : 30_000;
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

function isJoinNotInitializedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("NOT_INITIALIZED")
    || message.includes("WAITED_FOR_BACKEND_TABLE");
}

function isUnsupportedJoinPersistentSettingError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return message.includes("unknown setting persistent")
    && message.includes("sharedjoin");
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
  const timeoutMs = Number.isFinite(JOIN_READY_TIMEOUT_MS)
    ? Math.max(0, Math.floor(JOIN_READY_TIMEOUT_MS))
    : 120_000;
  const retryMs = Number.isFinite(JOIN_READY_RETRY_MS)
    ? Math.max(50, Math.floor(JOIN_READY_RETRY_MS))
    : 500;
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

async function refreshBlocksJoinTable(client: ClickHouseClient): Promise<void> {
  const createJoinTableQuery = (withPersistentSetting: boolean): string => `
      CREATE TABLE ${BLOCKS_JOIN_TABLE}
      ENGINE = Join(ANY, LEFT, block_number)
      ${withPersistentSetting ? "SETTINGS persistent = 0" : ""}
      AS
      SELECT
        block_number,
        any(timestamp) AS timestamp
      FROM polymarket_blocks
      GROUP BY block_number
    `;

  await command(client, `DROP TABLE IF EXISTS ${BLOCKS_JOIN_TABLE}`);
  try {
    await command(client, createJoinTableQuery(true));
  } catch (err) {
    if (!isUnsupportedJoinPersistentSettingError(err)) throw err;
    console.warn(
      "ClickHouse does not support Join table setting `persistent`; retrying without it.",
    );
    await command(client, createJoinTableQuery(false));
  }
}

async function applyTradeTimestampUpdate(
  client: ClickHouseClient,
  joinTableRef: string,
): Promise<void> {
  await waitForJoinTableReady(client, joinTableRef);
  await command(
    client,
    `
      ALTER TABLE polymarket_trades
      UPDATE timestamp = nullIf(joinGet('${joinTableRef}', 'timestamp', block_number), '')
      WHERE (${MISSING_TIMESTAMP_WHERE})
        AND joinGet('${joinTableRef}', 'timestamp', block_number) != ''
      SETTINGS mutations_sync = 2
    `,
  );
}

async function fetchMissingBlocks(client: ClickHouseClient): Promise<number[]> {
  const rows = await fetchRows<MissingBlockRow>(
    client,
    `
      SELECT DISTINCT t.block_number AS block_number
      FROM polymarket_trades t
      WHERE (${MISSING_TIMESTAMP_WHERE})
        AND t.block_number NOT IN (
          SELECT DISTINCT block_number
          FROM polymarket_blocks
          WHERE timestamp IS NOT NULL AND timestamp != ''
        )
      ORDER BY block_number
    `,
  );

  return rows
    .map((row) => toNumber(row.block_number))
    .filter((n) => Number.isFinite(n) && n > 0);
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
  const joinTableRef = `${CLICKHOUSE_DATABASE}.${BLOCKS_JOIN_TABLE}`;
  const rpcConcurrency = Math.max(1, Math.floor(RPC_FALLBACK_CONCURRENCY));

  try {
    console.log(
      `Backfilling polymarket_trades.timestamp (db=${CLICKHOUSE_DATABASE}, url=${CLICKHOUSE_URL}, rpc_fallback=${options.rpcFallback}, dry_run=${options.dryRun})`,
    );
    console.log(
      `Step progress logging interval: ${Math.max(0, Math.floor(STEP_PROGRESS_LOG_MS))}ms (set PM_TRADES_TS_BACKFILL_STEP_PROGRESS_LOG_MS=0 to disable)`,
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

    if (options.dryRun) {
      const missingBlocks = await runStep(
        "Fetch missing block references",
        async () => await fetchMissingBlocks(client),
      );
      console.log(
        `Missing block timestamp references after existing-block join pass: ${missingBlocks.length}`,
      );
      if (missingBlocks.length > 0) {
        if (!options.rpcFallback) {
          console.log(
            "RPC fallback disabled. Rows for these blocks will remain null unless polymarket_blocks is populated first.",
          );
        } else {
          console.log(
            `[dry-run] would fetch ${missingBlocks.length} block timestamps from RPC with concurrency=${rpcConcurrency}`,
          );
        }
      }
      console.log("[dry-run] Skipping UPDATE mutations.");
      return;
    }

    console.log("Applying existing polymarket_blocks timestamps...");
    await runStep(
      "Build polymarket_blocks join table",
      async () => await refreshBlocksJoinTable(client),
    );
    await runStep(
      "Update polymarket_trades from existing blocks",
      async () => await applyTradeTimestampUpdate(client, joinTableRef),
    );

    const missingAfterJoinPass = await runStep(
      "Count missing timestamps after existing-block pass",
      async () => await countMissingTradeTimestamps(client),
    );
    const updatedAfterJoinPass = Math.max(0, missingBefore - missingAfterJoinPass);
    console.log(`Rows updated in existing-block pass: ${updatedAfterJoinPass}`);
    console.log(
      `Missing timestamp rows after existing-block pass: ${missingAfterJoinPass}`,
    );
    if (missingAfterJoinPass === 0) {
      console.log(
        `Backfill complete: updated=${missingBefore}, missing_before=${missingBefore}, missing_after=0`,
      );
      return;
    }

    const missingBlocks = await runStep(
      "Fetch block references still missing timestamps",
      async () => await fetchMissingBlocks(client),
    );
    if (missingBlocks.length > 0) {
      console.log(
        `Missing block timestamp references: ${missingBlocks.length}`,
      );
      if (!options.rpcFallback) {
        console.log(
          "RPC fallback disabled. Rows for these blocks will remain null unless polymarket_blocks is populated first.",
        );
      } else {
        console.log(
          `Fetching ${missingBlocks.length} block timestamps from RPC with concurrency=${rpcConcurrency}...`,
        );
        const records = await runStep(
          "Fetch missing block timestamps from Polygon RPC",
          async () => await fetchBlockTimestampsFromRpc(
            missingBlocks,
            rpcConcurrency,
          ),
        );
        if (records.length > 0) {
          await runStep(
            "Insert RPC-fetched block timestamps into polymarket_blocks",
            async () => await client.insert({
              table: "polymarket_blocks",
              values: records,
              format: "JSONEachRow",
              clickhouse_settings: {
                wait_end_of_query: 1,
              },
            }),
          );
          console.log("Applying RPC-fetched block timestamps...");
          await runStep(
            "Rebuild polymarket_blocks join table after RPC insert",
            async () => await refreshBlocksJoinTable(client),
          );
          await runStep(
            "Update polymarket_trades from RPC-fetched blocks",
            async () => await applyTradeTimestampUpdate(client, joinTableRef),
          );
        }
        console.log(
          `Inserted ${records.length} block timestamp rows into polymarket_blocks`,
        );
      }
    } else if (updatedAfterJoinPass === 0) {
      console.log(
        "No rows were updated and no missing block references were found. Verify polymarket_blocks.timestamp is populated and block_number values match polymarket_trades.",
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
  } finally {
    try {
      await command(client, `DROP TABLE IF EXISTS ${BLOCKS_JOIN_TABLE}`);
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
