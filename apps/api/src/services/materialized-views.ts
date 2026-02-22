import { clickhouseService } from "./clickhouse";

const VIEW_QUERIES: string[] = [
  `
    CREATE OR REPLACE VIEW mv_daily_volume AS
    SELECT
      toDate(parseDateTimeBestEffortOrNull(created_time)) AS day,
      count() AS trade_count,
      sum(\`count\`) AS contract_count,
      sum(\`count\` * yes_price) AS notional_cents
    FROM kalshi_trades
    WHERE parseDateTimeBestEffortOrNull(created_time) IS NOT NULL
    GROUP BY day
    ORDER BY day
  `,
  `
    CREATE OR REPLACE VIEW mv_price_distribution AS
    SELECT
      yes_price,
      taker_side,
      count() AS trade_count,
      sum(\`count\`) AS contract_count
    FROM kalshi_trades
    GROUP BY yes_price, taker_side
    ORDER BY yes_price
  `,
  `
    CREATE OR REPLACE VIEW mv_category_summary AS
    SELECT
      if(event_ticker = '' OR event_ticker IS NULL, 'independent', extract(event_ticker, '^([A-Z0-9]+)')) AS category,
      status,
      count() AS market_count,
      sum(volume) AS total_volume
    FROM kalshi_markets
    GROUP BY category, status
  `,
  `
    CREATE OR REPLACE VIEW mv_kalshi_calibration AS
    WITH resolved AS (
      SELECT ticker, result
      FROM kalshi_markets
      WHERE status = 'finalized' AND result IN ('yes', 'no')
    )
    SELECT
      if(t.taker_side = 'yes', t.yes_price, t.no_price) AS price,
      count() AS trade_count,
      sum(t.\`count\`) AS contract_count,
      sum(if(t.taker_side = m.result, t.\`count\`, 0)) AS taker_won_contracts,
      sum(if(t.taker_side = m.result, 1, 0)) AS taker_won_trades
    FROM kalshi_trades t
    INNER JOIN resolved m ON t.ticker = m.ticker
    GROUP BY price
    ORDER BY price
  `,
  `
    CREATE OR REPLACE VIEW mv_pm_market_tokens AS
    SELECT *
    FROM (
      SELECT
        id AS market_id,
        condition_id,
        question,
        slug,
        nullIf(category, '') AS category,
        if(tags = '', '[]', tags) AS tags,
        toInt32(idx) AS outcome_index,
        arrayElement(outcomes_arr, idx + 1) AS outcome_name,
        arrayElement(token_ids_arr, idx + 1) AS token_id,
        active,
        closed,
        end_date,
        created_at,
        volume,
        liquidity
      FROM (
        SELECT
          *,
          ifNull(JSONExtract(outcomes, 'Array(String)'), []) AS outcomes_arr,
          ifNull(JSONExtract(clob_token_ids, 'Array(String)'), []) AS token_ids_arr,
          greatest(
            length(ifNull(JSONExtract(outcomes, 'Array(String)'), [])),
            length(ifNull(JSONExtract(clob_token_ids, 'Array(String)'), []))
          ) AS pair_count
        FROM polymarket_markets
      ) src
      ARRAY JOIN range(toUInt64(pair_count)) AS idx
    ) expanded
    WHERE token_id IS NOT NULL AND token_id != ''
  `,
  `
    CREATE OR REPLACE VIEW mv_pm_trades_base AS
    SELECT
      block_number,
      timestamp,
      transaction_hash,
      log_index,
      order_hash,
      maker,
      taker,
      maker_asset_id,
      taker_asset_id,
      maker_amount,
      taker_amount,
      fee,
      _contract,
      if(maker_asset_id = '0', taker_asset_id, maker_asset_id) AS token_id,
      if(maker_asset_id = '0', maker_amount, taker_amount) AS usdc_amount,
      if(maker_asset_id = '0', taker_amount, maker_amount) AS token_amount,
      if(maker_asset_id = '0', 'buy', 'sell') AS taker_side
    FROM polymarket_trades
    WHERE maker_asset_id != taker_asset_id
  `,
  `
    CREATE OR REPLACE VIEW mv_pm_trades_enriched AS
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
    FROM mv_pm_trades_base t
    INNER JOIN mv_pm_market_tokens m ON t.token_id = m.token_id
  `,
  `
    CREATE OR REPLACE VIEW mv_pm_resolved_markets AS
    WITH
      ifNull(JSONExtract(clob_token_ids, 'Array(String)'), []) AS token_ids_arr,
      ifNull(JSONExtract(outcome_prices, 'Array(Float64)'), []) AS outcome_prices_arr
    SELECT
      id,
      question,
      arrayElement(token_ids_arr, 1) AS yes_token,
      arrayElement(token_ids_arr, 2) AS no_token,
      arrayElement(outcome_prices_arr, 1) AS yes_final_price,
      arrayElement(outcome_prices_arr, 2) AS no_final_price,
      if(arrayElement(outcome_prices_arr, 1) > 0.99, 'Yes', 'No') AS winning_outcome,
      volume,
      created_at
    FROM polymarket_markets
    WHERE
      closed = 1
      AND (
        arrayElement(outcome_prices_arr, 1) > 0.99
        OR arrayElement(outcome_prices_arr, 2) > 0.99
      )
  `,
  `
    CREATE OR REPLACE VIEW mv_pm_token_lookup AS
    SELECT
      yes_token AS token_id,
      toUInt8(winning_outcome = 'Yes') AS won
    FROM mv_pm_resolved_markets
    UNION ALL
    SELECT
      no_token AS token_id,
      toUInt8(winning_outcome = 'No') AS won
    FROM mv_pm_resolved_markets
  `,
  `
    CREATE OR REPLACE VIEW mv_pm_calibration AS
    WITH trades_priced AS (
      SELECT
        round(usdc_amount * 100.0 / nullIf(token_amount, 0)) AS price,
        lk.won AS won
      FROM mv_pm_trades_base t
      INNER JOIN mv_pm_token_lookup lk ON t.token_id = lk.token_id
      WHERE token_amount > 0
    )
    SELECT
      price,
      count() AS trade_count,
      sum(if(won = 1, 1, 0)) AS won_trades
    FROM trades_priced
    WHERE price BETWEEN 1 AND 99
    GROUP BY price
    ORDER BY price
  `,
  `
    CREATE OR REPLACE VIEW mv_pm_daily_volume AS
    SELECT
      toDate(parseDateTimeBestEffortOrNull(timestamp)) AS day,
      count() AS trade_count,
      sum(usdc_amount) AS volume_usdc
    FROM mv_pm_trades_base
    WHERE parseDateTimeBestEffortOrNull(timestamp) IS NOT NULL
    GROUP BY day
    ORDER BY day
  `,
  `
    CREATE OR REPLACE VIEW mv_pm_trader_summary AS
    WITH
      resolved_tokens AS (
        SELECT yes_token AS token_id, toUInt8(1) AS is_yes, winning_outcome
        FROM mv_pm_resolved_markets
        UNION ALL
        SELECT no_token AS token_id, toUInt8(0) AS is_yes, winning_outcome
        FROM mv_pm_resolved_markets
      ),
      trader_flows AS (
        SELECT
          taker AS address,
          token_id,
          if(taker_side = 'buy', -toFloat64(usdc_amount), toFloat64(usdc_amount)) AS usdc_flow,
          if(taker_side = 'buy', toFloat64(token_amount), -toFloat64(token_amount)) AS token_flow
        FROM mv_pm_trades_base
        UNION ALL
        SELECT
          maker AS address,
          token_id,
          if(taker_side = 'buy', toFloat64(usdc_amount), -toFloat64(usdc_amount)) AS usdc_flow,
          if(taker_side = 'buy', -toFloat64(token_amount), toFloat64(token_amount)) AS token_flow
        FROM mv_pm_trades_base
      )
    SELECT
      tf.address,
      count() AS trade_count,
      sum(abs(tf.usdc_flow)) / 1e6 AS total_volume_usd,
      sum(
        if(
          rt.token_id != '',
          if(
            (rt.is_yes = 1 AND rt.winning_outcome = 'Yes') OR (rt.is_yes = 0 AND rt.winning_outcome = 'No'),
            tf.token_flow / 1e6,
            0
          ) + tf.usdc_flow / 1e6,
          0
        )
      ) AS realized_pnl_usd
    FROM trader_flows tf
    LEFT JOIN resolved_tokens rt ON tf.token_id = rt.token_id
    GROUP BY tf.address
  `,
  `
    CREATE OR REPLACE VIEW mv_pm_market_summary AS
    SELECT
      if(closed = 1, 'closed', if(active = 1, 'active', 'inactive')) AS status,
      count() AS market_count,
      sum(volume) AS total_volume,
      sum(liquidity) AS total_liquidity
    FROM polymarket_markets
    GROUP BY status
  `,
];

export async function createMaterializedViews() {
  const startedAt = Date.now();
  console.log("Creating ClickHouse views...");

  for (const sql of VIEW_QUERIES) {
    await clickhouseService.execute(sql, 240_000);
  }

  console.log(`ClickHouse views created in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
}
