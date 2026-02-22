import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { PolygonClient } from "./polymarket/blockchain";

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://localhost:8123";
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || "default";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || "";
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE || "default";
const RPC_FALLBACK_CONCURRENCY = Number(process.env.PM_TRADES_TS_BACKFILL_RPC_CONCURRENCY || "20");
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

async function fetchRows<T = Record<string, unknown>>(
  client: ClickHouseClient,
  query: string,
): Promise<T[]> {
  const result = await client.query({
    query,
    format: "JSONEachRow",
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

async function refreshBlocksJoinTable(client: ClickHouseClient): Promise<void> {
  await command(client, `DROP TABLE IF EXISTS ${BLOCKS_JOIN_TABLE}`);
  await command(
    client,
    `
      CREATE TABLE ${BLOCKS_JOIN_TABLE}
      ENGINE = Join(ANY, LEFT, block_number)
      AS
      SELECT
        block_number,
        any(timestamp) AS timestamp
      FROM polymarket_blocks
      GROUP BY block_number
    `,
  );
}

async function applyTradeTimestampUpdate(
  client: ClickHouseClient,
  joinTableRef: string,
): Promise<void> {
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

    const missingBefore = await countMissingTradeTimestamps(client);
    if (missingBefore === 0) {
      console.log("No missing timestamps in polymarket_trades; nothing to do.");
      return;
    }
    console.log(`Missing timestamp rows before backfill: ${missingBefore}`);

    if (options.dryRun) {
      const missingBlocks = await fetchMissingBlocks(client);
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
    await refreshBlocksJoinTable(client);
    await applyTradeTimestampUpdate(client, joinTableRef);

    const missingAfterJoinPass = await countMissingTradeTimestamps(client);
    console.log(
      `Missing timestamp rows after existing-block pass: ${missingAfterJoinPass}`,
    );
    if (missingAfterJoinPass === 0) {
      console.log(
        `Backfill complete: updated=${missingBefore}, missing_before=${missingBefore}, missing_after=0`,
      );
      return;
    }

    const missingBlocks = await fetchMissingBlocks(client);
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
        const records = await fetchBlockTimestampsFromRpc(
          missingBlocks,
          rpcConcurrency,
        );
        if (records.length > 0) {
          await client.insert({
            table: "polymarket_blocks",
            values: records,
            format: "JSONEachRow",
          });
          console.log("Applying RPC-fetched block timestamps...");
          await refreshBlocksJoinTable(client);
          await applyTradeTimestampUpdate(client, joinTableRef);
        }
        console.log(
          `Inserted ${records.length} block timestamp rows into polymarket_blocks`,
        );
      }
    }

    const missingAfter = await countMissingTradeTimestamps(client);
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
