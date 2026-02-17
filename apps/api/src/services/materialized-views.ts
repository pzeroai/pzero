import { duckdbService, MARKETS_DIR, TRADES_DIR, PM_MARKETS_DIR, PM_TRADES_DIR, PM_BLOCKS_DIR } from "./duckdb";
import { existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";

async function hasParquetColumn(parquetGlob: string, column: string): Promise<boolean> {
  try {
    await duckdbService.query(
      `SELECT "${column}" FROM read_parquet('${parquetGlob}', union_by_name=true) LIMIT 1`,
      30_000,
    );
    return true;
  } catch {
    return false;
  }
}

function removeAppleDoubleParquetFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        removed += removeAppleDoubleParquetFiles(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("._")) continue;
      if (!entry.name.endsWith(".parquet")) continue;
      try {
        unlinkSync(fullPath);
        removed++;
      } catch {
        // Best-effort cleanup; continue.
      }
    }
  } catch {
    // Ignore listing errors, handled by downstream read errors if any.
  }
  return removed;
}

export async function createMaterializedViews() {
  console.log("Creating materialized views...");

  const pmMarketsGlob = `${PM_MARKETS_DIR}/*.parquet`;
  const pmTradesGlob = `${PM_TRADES_DIR}/*.parquet`;
  const pmBlocksGlob = `${PM_BLOCKS_DIR}/*.parquet`;

  // Remove macOS AppleDouble sidecar files (._*.parquet) that break DuckDB parquet scans.
  const cleanedCount =
    removeAppleDoubleParquetFiles(PM_MARKETS_DIR) +
    removeAppleDoubleParquetFiles(PM_TRADES_DIR) +
    removeAppleDoubleParquetFiles(PM_BLOCKS_DIR) +
    removeAppleDoubleParquetFiles(MARKETS_DIR) +
    removeAppleDoubleParquetFiles(TRADES_DIR);
  if (cleanedCount > 0) {
    console.warn(`Removed ${cleanedCount} AppleDouble sidecar parquet file(s) before view build`);
  }

  const pmHasCategory = await hasParquetColumn(pmMarketsGlob, "category");
  const pmHasTags = await hasParquetColumn(pmMarketsGlob, "tags");
  const pmHasContract = await hasParquetColumn(pmTradesGlob, "_contract");
  const pmHasTradeTimestamp = await hasParquetColumn(pmTradesGlob, "timestamp");
  const pmHasBlockTimestamp = await hasParquetColumn(pmBlocksGlob, "timestamp");

  const pmCategoryExpr = pmHasCategory
    ? "COALESCE(NULLIF(category, ''), 'uncategorized')"
    : "NULL::VARCHAR";
  const pmTagsExpr = pmHasTags ? "COALESCE(NULLIF(tags, ''), '[]')" : "'[]'";
  const pmContractExpr = pmHasContract ? "t._contract AS _contract" : "NULL::VARCHAR AS _contract";
  let pmTimestampExpr = "NULL::VARCHAR";
  let pmTimestampJoin = "";
  if (pmHasTradeTimestamp && pmHasBlockTimestamp) {
    pmTimestampExpr = "COALESCE(CAST(t.timestamp AS VARCHAR), b.timestamp)";
    pmTimestampJoin =
      `LEFT JOIN read_parquet('${pmBlocksGlob}', union_by_name=true) b ON t.block_number = b.block_number`;
  } else if (pmHasTradeTimestamp) {
    pmTimestampExpr = "CAST(t.timestamp AS VARCHAR)";
  } else if (pmHasBlockTimestamp) {
    pmTimestampExpr = "b.timestamp";
    pmTimestampJoin =
      `INNER JOIN read_parquet('${pmBlocksGlob}', union_by_name=true) b ON t.block_number = b.block_number`;
  } else {
    console.warn(
      "Neither trade timestamps nor block timestamp parquet are available; mv_pm_trades_with_ts.timestamp will be NULL.",
    );
  }

  await duckdbService.query(`
    CREATE TABLE IF NOT EXISTS mv_daily_volume AS
    SELECT DATE_TRUNC('day', created_time) AS day,
           COUNT(*) AS trade_count,
           SUM(count) AS contract_count,
           SUM(count * yes_price) AS notional_cents
    FROM '${TRADES_DIR}/*.parquet'
    GROUP BY 1
    ORDER BY 1
  `, 120_000);

  await duckdbService.query(`
    CREATE TABLE IF NOT EXISTS mv_price_distribution AS
    SELECT yes_price,
           taker_side,
           COUNT(*) AS trade_count,
           SUM(count) AS contract_count
    FROM '${TRADES_DIR}/*.parquet'
    GROUP BY 1, 2
    ORDER BY 1
  `, 120_000);

  await duckdbService.query(`
    CREATE TABLE IF NOT EXISTS mv_category_summary AS
    SELECT
      CASE
        WHEN event_ticker IS NULL OR event_ticker = '' THEN 'independent'
        ELSE regexp_extract(event_ticker, '^([A-Z0-9]+)', 1)
      END AS category,
      status,
      COUNT(*) AS market_count,
      SUM(volume) AS total_volume
    FROM '${MARKETS_DIR}/*.parquet'
    GROUP BY 1, 2
  `, 120_000);

  // Kalshi: calibration — win rate by the price the taker actually paid
  console.log("  mv_kalshi_calibration...");
  await duckdbService.query(`
    CREATE TABLE IF NOT EXISTS mv_kalshi_calibration AS
    WITH resolved AS (
      SELECT ticker, result
      FROM '${MARKETS_DIR}/*.parquet'
      WHERE status = 'finalized' AND result IN ('yes', 'no')
    )
    SELECT
      CASE WHEN t.taker_side = 'yes' THEN t.yes_price ELSE t.no_price END AS price,
      COUNT(*) AS trade_count,
      SUM(t.count) AS contract_count,
      SUM(CASE WHEN t.taker_side = m.result THEN t.count ELSE 0 END) AS taker_won_contracts,
      SUM(CASE WHEN t.taker_side = m.result THEN 1 ELSE 0 END) AS taker_won_trades
    FROM '${TRADES_DIR}/*.parquet' t
    INNER JOIN resolved m ON t.ticker = m.ticker
    GROUP BY 1
    ORDER BY 1
  `, 600_000);

  // Polymarket: token-normalized market mapping (token_id -> market/outcome metadata)
  console.log("  mv_pm_market_tokens...");
  await duckdbService.query(`
    CREATE TABLE IF NOT EXISTS mv_pm_market_tokens AS
    WITH base AS (
      SELECT
        id AS market_id,
        condition_id,
        question,
        slug,
        ${pmCategoryExpr} AS category,
        ${pmTagsExpr} AS tags,
        COALESCE(NULLIF(outcomes, ''), '[]') AS outcomes_json,
        COALESCE(NULLIF(clob_token_ids, ''), '[]') AS token_ids_json,
        active,
        closed,
        end_date,
        created_at,
        volume,
        liquidity
      FROM read_parquet('${pmMarketsGlob}', union_by_name=true)
    ),
    expanded AS (
      SELECT
        b.*,
        r.i AS outcome_index
      FROM base b
      CROSS JOIN LATERAL range(
        CAST(0 AS BIGINT),
        GREATEST(
          COALESCE(TRY_CAST(json_array_length(b.token_ids_json) AS BIGINT), 0),
          COALESCE(TRY_CAST(json_array_length(b.outcomes_json) AS BIGINT), 0)
        )
      ) AS r(i)
    ),
    normalized AS (
      SELECT
        market_id,
        condition_id,
        question,
        slug,
        category,
        tags,
        CAST(outcome_index AS INTEGER) AS outcome_index,
        json_extract_string(outcomes_json, '$[' || CAST(outcome_index AS VARCHAR) || ']') AS outcome_name,
        json_extract_string(token_ids_json, '$[' || CAST(outcome_index AS VARCHAR) || ']') AS token_id,
        active,
        closed,
        end_date,
        created_at,
        volume,
        liquidity
      FROM expanded
    )
    SELECT *
    FROM normalized
    WHERE token_id IS NOT NULL AND token_id != ''
  `, 600_000);

  const pmTradesWithTsSelect = `
    SELECT
      t.block_number,
      ${pmTimestampExpr} AS timestamp,
      t.transaction_hash,
      t.log_index,
      t.order_hash,
      t.maker,
      t.taker,
      CAST(t.maker_asset_id AS VARCHAR) AS maker_asset_id,
      CAST(t.taker_asset_id AS VARCHAR) AS taker_asset_id,
      t.maker_amount,
      t.taker_amount,
      t.fee,
      ${pmContractExpr},
      CASE
        WHEN CAST(t.maker_asset_id AS VARCHAR) = '0'
        THEN CAST(t.taker_asset_id AS VARCHAR)
        ELSE CAST(t.maker_asset_id AS VARCHAR)
      END AS token_id,
      CASE
        WHEN CAST(t.maker_asset_id AS VARCHAR) = '0'
        THEN t.maker_amount
        ELSE t.taker_amount
      END AS usdc_amount,
      CASE
        WHEN CAST(t.maker_asset_id AS VARCHAR) = '0'
        THEN t.taker_amount
        ELSE t.maker_amount
      END AS token_amount,
      CASE
        WHEN CAST(t.maker_asset_id AS VARCHAR) = '0'
        THEN 'buy'
        ELSE 'sell'
      END AS taker_side
    FROM read_parquet('${pmTradesGlob}', union_by_name=true) t
    ${pmTimestampJoin}
    WHERE CAST(t.maker_asset_id AS VARCHAR) != CAST(t.taker_asset_id AS VARCHAR)
  `;

  // Polymarket: prejoined trades + timestamps + normalized token id.
  console.log("  mv_pm_trades_with_ts...");
  await duckdbService.query(
    `CREATE VIEW IF NOT EXISTS mv_pm_trades_with_ts AS ${pmTradesWithTsSelect}`,
    120_000,
  );

  // Polymarket: enriched trades with market/outcome metadata via token_id equi-join.
  console.log("  mv_pm_trades_enriched...");
  await duckdbService.query(`
    CREATE VIEW IF NOT EXISTS mv_pm_trades_enriched AS
    SELECT
      t.*,
      m.market_id,
      m.condition_id,
      m.question,
      m.slug,
      m.category,
      m.tags,
      m.outcome_index,
      m.outcome_name,
      m.active AS market_active,
      m.closed AS market_closed,
      m.end_date AS market_end_date,
      m.created_at AS market_created_at,
      m.volume AS market_volume,
      m.liquidity AS market_liquidity
    FROM mv_pm_trades_with_ts t
    INNER JOIN mv_pm_market_tokens m ON t.token_id = m.token_id
  `, 120_000);

  // Polymarket: resolved markets with token mapping
  console.log("  mv_pm_resolved_markets...");
  await duckdbService.query(`
    CREATE TABLE IF NOT EXISTS mv_pm_resolved_markets AS
    SELECT id, question,
           json_extract_string(clob_token_ids, '$[0]') AS yes_token,
           json_extract_string(clob_token_ids, '$[1]') AS no_token,
           CAST(json_extract_string(outcome_prices, '$[0]') AS DOUBLE) AS yes_final_price,
           CAST(json_extract_string(outcome_prices, '$[1]') AS DOUBLE) AS no_final_price,
           CASE WHEN CAST(json_extract_string(outcome_prices, '$[0]') AS DOUBLE) > 0.99 THEN 'Yes' ELSE 'No' END AS winning_outcome,
           volume, created_at
    FROM read_parquet('${pmMarketsGlob}', union_by_name=true)
    WHERE closed = true
    AND (CAST(json_extract_string(outcome_prices, '$[0]') AS DOUBLE) > 0.99
      OR CAST(json_extract_string(outcome_prices, '$[1]') AS DOUBLE) > 0.99)
  `, 120_000);

  // Polymarket: flat token lookup (token_id -> won boolean) for fast equi-join
  console.log("  mv_pm_token_lookup...");
  await duckdbService.query(`
    CREATE TABLE IF NOT EXISTS mv_pm_token_lookup AS
    SELECT yes_token AS token_id, CASE WHEN winning_outcome = 'Yes' THEN true ELSE false END AS won
    FROM mv_pm_resolved_markets
    UNION ALL
    SELECT no_token AS token_id, CASE WHEN winning_outcome = 'No' THEN true ELSE false END AS won
    FROM mv_pm_resolved_markets
  `, 120_000);

  // Polymarket: calibration — win rate by price bucket.
  console.log("  mv_pm_calibration...");
  await duckdbService.query(`
    CREATE TABLE IF NOT EXISTS mv_pm_calibration AS
    WITH trades_priced AS (
      SELECT
        ROUND(t.usdc_amount * 100.0 / NULLIF(t.token_amount, 0)) AS price,
        lk.won
      FROM mv_pm_trades_with_ts t
      INNER JOIN mv_pm_token_lookup lk ON t.token_id = lk.token_id
      WHERE t.token_amount > 0
    )
    SELECT
      price,
      COUNT(*) AS trade_count,
      SUM(CASE WHEN won THEN 1 ELSE 0 END) AS won_trades
    FROM trades_priced
    WHERE price BETWEEN 1 AND 99
    GROUP BY 1
    ORDER BY 1
  `, 600_000);

  // Polymarket: daily volume (uses prejoined trades+timestamp view)
  console.log("  mv_pm_daily_volume...");
  await duckdbService.query(`
    CREATE TABLE IF NOT EXISTS mv_pm_daily_volume AS
    SELECT DATE_TRUNC('day', timestamp::TIMESTAMP) AS day,
           COUNT(*) AS trade_count,
           SUM(usdc_amount) AS volume_usdc
    FROM mv_pm_trades_with_ts
    WHERE timestamp IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  `, 600_000);

  // Polymarket: trader-level summary (volume + P&L on resolved markets)
  console.log("  mv_pm_trader_summary...");
  await duckdbService.query(`
    CREATE TABLE IF NOT EXISTS mv_pm_trader_summary AS
    WITH resolved_tokens AS (
      SELECT yes_token AS token_id, true AS is_yes, winning_outcome
      FROM mv_pm_resolved_markets
      UNION ALL
      SELECT no_token AS token_id, false AS is_yes, winning_outcome
      FROM mv_pm_resolved_markets
    ),
    trader_flows AS (
      SELECT
        t.taker AS address,
        'taker' AS role,
        CASE WHEN t.taker_side = 'buy'
          THEN -CAST(t.usdc_amount AS BIGINT)
          ELSE CAST(t.usdc_amount AS BIGINT)
        END AS usdc_flow,
        CASE WHEN t.taker_side = 'buy'
          THEN CAST(t.token_amount AS BIGINT)
          ELSE -CAST(t.token_amount AS BIGINT)
        END AS token_flow,
        t.token_id
      FROM mv_pm_trades_with_ts t
      UNION ALL
      SELECT
        t.maker AS address,
        'maker' AS role,
        CASE WHEN t.taker_side = 'buy'
          THEN CAST(t.usdc_amount AS BIGINT)
          ELSE -CAST(t.usdc_amount AS BIGINT)
        END AS usdc_flow,
        CASE WHEN t.taker_side = 'buy'
          THEN -CAST(t.token_amount AS BIGINT)
          ELSE CAST(t.token_amount AS BIGINT)
        END AS token_flow,
        t.token_id
      FROM mv_pm_trades_with_ts t
    )
    SELECT
      tf.address,
      COUNT(*) AS trade_count,
      SUM(ABS(tf.usdc_flow)) / 1e6 AS total_volume_usd,
      SUM(CASE
        WHEN rt.token_id IS NOT NULL THEN
          CASE
            WHEN (rt.is_yes AND rt.winning_outcome = 'Yes') OR (NOT rt.is_yes AND rt.winning_outcome = 'No')
            THEN tf.token_flow / 1e6
            ELSE 0
          END + tf.usdc_flow / 1e6
        ELSE 0
      END) AS realized_pnl_usd
    FROM trader_flows tf
    LEFT JOIN resolved_tokens rt ON tf.token_id = rt.token_id
    GROUP BY 1
  `, 600_000);

  // Polymarket: market summary
  console.log("  mv_pm_market_summary...");
  await duckdbService.query(`
    CREATE TABLE IF NOT EXISTS mv_pm_market_summary AS
    SELECT
      CASE WHEN closed THEN 'closed' WHEN active THEN 'active' ELSE 'inactive' END AS status,
      COUNT(*) AS market_count,
      SUM(volume) AS total_volume,
      SUM(liquidity) AS total_liquidity
    FROM read_parquet('${pmMarketsGlob}', union_by_name=true)
    GROUP BY 1
  `, 120_000);

  console.log("Materialized views created.");
}
