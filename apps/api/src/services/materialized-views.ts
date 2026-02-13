import { duckdbService, MARKETS_DIR, TRADES_DIR, PM_MARKETS_DIR, PM_TRADES_DIR, PM_BLOCKS_DIR } from "./duckdb";

export async function createMaterializedViews() {
  console.log("Creating materialized views...");

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
    FROM '${PM_MARKETS_DIR}/*.parquet'
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

  // Polymarket: calibration — win rate by price bucket (equi-join via token lookup)
  console.log("  mv_pm_calibration...");
  await duckdbService.query(`
    CREATE TABLE IF NOT EXISTS mv_pm_calibration AS
    WITH trades_priced AS (
      SELECT
        CASE
          WHEN t.maker_asset_id = '0' THEN ROUND(t.maker_amount * 100.0 / t.taker_amount)
          ELSE ROUND(t.taker_amount * 100.0 / t.maker_amount)
        END AS price,
        COALESCE(lk_taker.won, lk_maker.won) AS won
      FROM '${PM_TRADES_DIR}/*.parquet' t
      LEFT JOIN mv_pm_token_lookup lk_taker ON t.taker_asset_id = lk_taker.token_id
      LEFT JOIN mv_pm_token_lookup lk_maker ON t.maker_asset_id = lk_maker.token_id
      WHERE (lk_taker.token_id IS NOT NULL OR lk_maker.token_id IS NOT NULL)
        AND t.maker_asset_id != t.taker_asset_id
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

  // Polymarket: daily volume (join trades with blocks for timestamps)
  console.log("  mv_pm_daily_volume...");
  await duckdbService.query(`
    CREATE TABLE IF NOT EXISTS mv_pm_daily_volume AS
    SELECT DATE_TRUNC('day', b.timestamp::TIMESTAMP) AS day,
           COUNT(*) AS trade_count,
           SUM(CASE WHEN t.maker_asset_id = '0' THEN t.maker_amount ELSE t.taker_amount END) AS volume_usdc
    FROM '${PM_TRADES_DIR}/*.parquet' t
    INNER JOIN '${PM_BLOCKS_DIR}/*.parquet' b ON t.block_number = b.block_number
    GROUP BY 1
    ORDER BY 1
  `, 600_000);

  // Polymarket: trader-level summary (volume + P&L on resolved markets)
  console.log("  mv_pm_trader_summary...");
  await duckdbService.query(`
    CREATE TABLE IF NOT EXISTS mv_pm_trader_summary AS
    WITH resolved_tokens AS (
      SELECT yes_token AS token_id, true AS is_yes, winning_outcome, question
      FROM mv_pm_resolved_markets
      UNION ALL
      SELECT no_token AS token_id, false AS is_yes, winning_outcome, question
      FROM mv_pm_resolved_markets
    ),
    trader_trades AS (
      -- Taker side: taker gives USDC (maker_asset_id=0) or receives USDC
      SELECT
        t.taker AS address,
        'taker' AS role,
        CASE WHEN t.maker_asset_id = '0'
          THEN -CAST(t.maker_amount AS BIGINT)
          ELSE CAST(t.taker_amount AS BIGINT)
        END AS usdc_flow,
        CASE WHEN t.maker_asset_id = '0'
          THEN CAST(t.taker_amount AS BIGINT)
          ELSE -CAST(t.maker_amount AS BIGINT)
        END AS token_flow,
        CASE WHEN t.maker_asset_id = '0' THEN t.taker_asset_id ELSE t.maker_asset_id END AS token_id
      FROM '${PM_TRADES_DIR}/*.parquet' t
      WHERE t.maker_asset_id != t.taker_asset_id
      UNION ALL
      -- Maker side
      SELECT
        t.maker AS address,
        'maker' AS role,
        CASE WHEN t.maker_asset_id = '0'
          THEN -CAST(t.maker_amount AS BIGINT)
          ELSE CAST(t.taker_amount AS BIGINT)
        END AS usdc_flow,
        CASE WHEN t.maker_asset_id = '0'
          THEN CAST(t.taker_amount AS BIGINT)
          ELSE -CAST(t.maker_amount AS BIGINT)
        END AS token_flow,
        CASE WHEN t.maker_asset_id = '0' THEN t.taker_asset_id ELSE t.maker_asset_id END AS token_id
      FROM '${PM_TRADES_DIR}/*.parquet' t
      WHERE t.maker_asset_id != t.taker_asset_id
    )
    SELECT
      tt.address,
      COUNT(*) AS trade_count,
      SUM(ABS(tt.usdc_flow)) / 1e6 AS total_volume_usd,
      SUM(CASE
        WHEN rt.token_id IS NOT NULL THEN
          CASE
            WHEN (rt.is_yes AND rt.winning_outcome = 'Yes') OR (NOT rt.is_yes AND rt.winning_outcome = 'No')
            THEN tt.token_flow / 1e6
            ELSE 0
          END + tt.usdc_flow / 1e6
        ELSE 0
      END) AS realized_pnl_usd
    FROM trader_trades tt
    LEFT JOIN resolved_tokens rt ON CAST(tt.token_id AS VARCHAR) = rt.token_id
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
    FROM '${PM_MARKETS_DIR}/*.parquet'
    GROUP BY 1
  `, 120_000);

  console.log("Materialized views created.");
}
