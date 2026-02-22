import { clickhouseService } from "./clickhouse";

interface ExistingObjectRow {
  engine: string;
}

interface CountRow {
  c: number | string;
}

interface DayValueRow {
  day: string;
}

interface SqlSpec {
  name: string;
  sql: string;
}

export interface DailyVolumeRollupBackfillOptions {
  rebuild?: boolean;
  skipIfNotEmpty?: boolean;
  ensureObjects?: boolean;
}

export interface PmSemanticLayerBackfillOptions {
  rebuild?: boolean;
  skipIfNotEmpty?: boolean;
  ensureObjects?: boolean;
}

const MV_REBUILD = (process.env.API_MV_REBUILD || "0").toLowerCase();
const MV_BACKFILL_ON_STARTUP = (process.env.API_MV_BACKFILL_ON_STARTUP || "0").toLowerCase();
const MV_CANONICAL_BACKFILL_ON_STARTUP = (process.env.API_MV_CANONICAL_BACKFILL_ON_STARTUP || "0").toLowerCase();
const PM_SEMANTIC_ROLLUP_WINDOW_DAYS = Math.max(
  1,
  Math.floor(Number(process.env.API_PM_SEMANTIC_ROLLUP_WINDOW_DAYS || "7")),
);

const ROLLUP_TABLE_SPECS: SqlSpec[] = [
  {
    name: "pm_daily_volume_rollup",
    sql: `
      CREATE TABLE IF NOT EXISTS pm_daily_volume_rollup (
        day Date,
        trade_count UInt64,
        volume_usdc UInt64,
        volume_usd Float64
      )
      ENGINE = SummingMergeTree
      ORDER BY (day)
    `,
  },
];

const INGEST_MV_SPECS: SqlSpec[] = [
  {
    name: "mv_pm_daily_volume_ingest",
    sql: `
      CREATE MATERIALIZED VIEW IF NOT EXISTS mv_pm_daily_volume_ingest
      TO pm_daily_volume_rollup
      AS
      WITH parseDateTimeBestEffortOrNull(timestamp) AS parsed_ts
      SELECT
        toDate(assumeNotNull(parsed_ts)) AS day,
        toUInt64(1) AS trade_count,
        toUInt64(if(maker_asset_id = '0', maker_amount, taker_amount)) AS volume_usdc,
        toFloat64(if(maker_asset_id = '0', maker_amount, taker_amount)) / 1e6 AS volume_usd
      FROM polymarket_trades
      WHERE maker_asset_id != taker_asset_id
        AND parsed_ts IS NOT NULL
    `,
  },
];

const PM_MARKET_DIM_SELECT_SQL = `
  WITH
    ifNull(JSONExtract(outcome_prices, 'Array(Float64)'), []) AS outcome_prices_arr,
    arrayElement(outcome_prices_arr, 1) AS yes_final_price,
    arrayElement(outcome_prices_arr, 2) AS no_final_price,
    toUInt8(positionCaseInsensitive(question, 'Up or Down') > 0) AS is_up_down_market_expr,
    multiIf(
      match(lower(question), '\\\\bbitcoin\\\\b|\\\\bbtc\\\\b'),
      'BTC',
      match(lower(question), '\\\\bethereum\\\\b|\\\\beth\\\\b'),
      'ETH',
      match(lower(question), '\\\\bsolana\\\\b|\\\\bsol\\\\b'),
      'SOL',
      match(lower(question), '\\\\bxrp\\\\b|\\\\bripple\\\\b'),
      'XRP',
      match(lower(question), '\\\\bdoge\\\\b|\\\\bdogecoin\\\\b'),
      'DOGE',
      ''
    ) AS asset_symbol_expr,
    coalesce(parseDateTimeBestEffortOrNull(_fetched_at), now()) AS updated_at
  SELECT
    id AS market_id,
    condition_id,
    question,
    slug,
    ifNull(category, '') AS category,
    lowerUTF8(ifNull(category, '')) AS category_norm,
    if(tags = '', '[]', tags) AS tags,
    active,
    closed,
    parseDateTimeBestEffortOrNull(created_at) AS created_at_dt,
    parseDateTimeBestEffortOrNull(end_date) AS end_date_dt,
    is_up_down_market_expr AS is_up_down_market,
    toUInt16(
      multiIf(
        match(lower(question), '(:00(am|pm)-[0-9]{1,2}:15(am|pm)|:15(am|pm)-[0-9]{1,2}:30(am|pm)|:30(am|pm)-[0-9]{1,2}:45(am|pm)|:45(am|pm)-[0-9]{1,2}:00(am|pm))'),
        15,
        positionCaseInsensitive(question, '15 min') > 0 OR positionCaseInsensitive(question, '15-minute') > 0 OR positionCaseInsensitive(question, '15 minute') > 0,
        15,
        positionCaseInsensitive(question, '5 min') > 0 OR positionCaseInsensitive(question, '5-minute') > 0 OR positionCaseInsensitive(question, '5 minute') > 0,
        5,
        0
      )
    ) AS interval_minutes,
    asset_symbol_expr AS asset_symbol,
    multiIf(
      asset_symbol_expr != '',
      'crypto',
      positionCaseInsensitive(question, 'election') > 0,
      'politics',
      positionCaseInsensitive(question, 'nba') > 0 OR positionCaseInsensitive(question, 'nfl') > 0 OR positionCaseInsensitive(question, 'mlb') > 0,
      'sports',
      'other'
    ) AS asset_family,
    multiIf(
      is_up_down_market_expr = 1,
      'up_down_interval',
      startsWith(lower(question), 'will ') OR positionCaseInsensitive(question, ' will ') > 0,
      'binary',
      'other'
    ) AS event_type,
    toUInt8(
      asset_symbol_expr != ''
      OR positionCaseInsensitive(ifNull(category, ''), 'crypto') > 0
      OR positionCaseInsensitive(if(tags = '', '[]', tags), 'crypto') > 0
    ) AS is_crypto,
    toUInt8(closed = 1 AND (yes_final_price > 0.99 OR no_final_price > 0.99)) AS is_resolved,
    multiIf(yes_final_price > 0.99, 'Yes', no_final_price > 0.99, 'No', '') AS winning_outcome,
    updated_at
  FROM polymarket_markets
`;

const PM_TOKEN_DIM_SELECT_SQL = `
  WITH
    ifNull(JSONExtract(outcomes, 'Array(String)'), []) AS outcomes_arr,
    ifNull(JSONExtract(clob_token_ids, 'Array(String)'), []) AS token_ids_arr,
    greatest(length(outcomes_arr), length(token_ids_arr)) AS pair_count,
    coalesce(parseDateTimeBestEffortOrNull(_fetched_at), now()) AS updated_at
  SELECT
    arrayElement(token_ids_arr, idx + 1) AS token_id,
    condition_id,
    id AS market_id,
    question,
    ifNull(category, '') AS category,
    lowerUTF8(ifNull(category, '')) AS category_norm,
    if(tags = '', '[]', tags) AS tags,
    toInt32(idx) AS outcome_index,
    arrayElement(outcomes_arr, idx + 1) AS outcome_name,
    active,
    closed,
    parseDateTimeBestEffortOrNull(created_at) AS created_at_dt,
    parseDateTimeBestEffortOrNull(end_date) AS end_date_dt,
    updated_at
  FROM polymarket_markets
  ARRAY JOIN range(toUInt64(pair_count)) AS idx
  WHERE
    arrayElement(token_ids_arr, idx + 1) IS NOT NULL
    AND arrayElement(token_ids_arr, idx + 1) != ''
`;

const PM_RESOLUTION_DIM_SELECT_SQL = `
  WITH
    ifNull(JSONExtract(clob_token_ids, 'Array(String)'), []) AS token_ids_arr,
    ifNull(JSONExtract(outcome_prices, 'Array(Float64)'), []) AS outcome_prices_arr,
    arrayElement(outcome_prices_arr, 1) AS yes_final_price,
    arrayElement(outcome_prices_arr, 2) AS no_final_price,
    coalesce(parseDateTimeBestEffortOrNull(_fetched_at), now()) AS updated_at
  SELECT
    arrayElement(token_ids_arr, 1) AS token_id,
    condition_id,
    toUInt8(yes_final_price > 0.99) AS won,
    multiIf(yes_final_price > 0.99, 'Yes', no_final_price > 0.99, 'No', '') AS winning_outcome,
    toUInt8(closed = 1 AND (yes_final_price > 0.99 OR no_final_price > 0.99)) AS is_resolved,
    parseDateTimeBestEffortOrNull(end_date) AS resolved_at,
    updated_at
  FROM polymarket_markets
  WHERE
    closed = 1
    AND (yes_final_price > 0.99 OR no_final_price > 0.99)
    AND arrayElement(token_ids_arr, 1) IS NOT NULL
    AND arrayElement(token_ids_arr, 1) != ''

  UNION ALL

  SELECT
    arrayElement(token_ids_arr, 2) AS token_id,
    condition_id,
    toUInt8(no_final_price > 0.99) AS won,
    multiIf(yes_final_price > 0.99, 'Yes', no_final_price > 0.99, 'No', '') AS winning_outcome,
    toUInt8(closed = 1 AND (yes_final_price > 0.99 OR no_final_price > 0.99)) AS is_resolved,
    parseDateTimeBestEffortOrNull(end_date) AS resolved_at,
    updated_at
  FROM polymarket_markets
  WHERE
    closed = 1
    AND (yes_final_price > 0.99 OR no_final_price > 0.99)
    AND arrayElement(token_ids_arr, 2) IS NOT NULL
    AND arrayElement(token_ids_arr, 2) != ''
`;

const PM_TRADE_FCT_SELECT_SQL = `
  WITH
    parseDateTimeBestEffortOrNull(t.timestamp) AS parsed_ts,
    if(t.maker_asset_id = '0', t.taker_asset_id, t.maker_asset_id) AS token_id_expr,
    if(t.maker_asset_id = '0', t.maker_amount, t.taker_amount) AS usdc_amount_expr,
    if(t.maker_asset_id = '0', t.taker_amount, t.maker_amount) AS token_amount_expr
  SELECT
    toDate(assumeNotNull(parsed_ts)) AS day,
    assumeNotNull(parsed_ts) AS timestamp_dt,
    t.block_number,
    t.transaction_hash,
    t.log_index,
    t.order_hash,
    t.maker,
    t.taker,
    t.maker_asset_id,
    t.taker_asset_id,
    t.maker_amount,
    t.taker_amount,
    t.fee,
    token_id_expr AS token_id,
    ifNull(td.condition_id, '') AS condition_id,
    ifNull(td.market_id, '') AS market_id,
    ifNull(td.outcome_index, toInt32(-1)) AS outcome_index,
    ifNull(td.outcome_name, '') AS outcome_name,
    if(t.maker_asset_id = '0', 'buy', 'sell') AS taker_side,
    usdc_amount_expr AS usdc_amount,
    token_amount_expr AS token_amount,
    toFloat64(usdc_amount_expr) / nullIf(toFloat64(token_amount_expr), 0) AS price,
    toFloat64(token_amount_expr) / 1e6 AS amount,
    toFloat64(usdc_amount_expr) / 1e6 AS volume_usd,
    t._contract,
    t._fetched_at
  FROM polymarket_trades t
  LEFT JOIN (
    SELECT
      token_id,
      any(condition_id) AS condition_id,
      any(market_id) AS market_id,
      any(outcome_index) AS outcome_index,
      any(outcome_name) AS outcome_name
    FROM pm_token_dim
    GROUP BY token_id
  ) td ON token_id_expr = td.token_id
  WHERE
    t.maker_asset_id != t.taker_asset_id
    AND parsed_ts IS NOT NULL
`;

function buildPmTraderMarketRollupDailySelectSql(dayFilterClause = ""): string {
  return `
    SELECT
      day,
      condition_id,
      token_id,
      address,
      toUInt64(count()) AS trade_count,
      sum(abs(usdc_delta_usd)) AS total_volume_usd,
      sum(usdc_delta_usd) AS usdc_flow_usd,
      sum(token_delta_usd) AS token_flow_usd
    FROM (
      SELECT
        day,
        condition_id,
        token_id,
        taker AS address,
        if(taker_side = 'buy', -toFloat64(usdc_amount) / 1e6, toFloat64(usdc_amount) / 1e6) AS usdc_delta_usd,
        if(taker_side = 'buy', toFloat64(token_amount) / 1e6, -toFloat64(token_amount) / 1e6) AS token_delta_usd
      FROM pm_trade_fct
      ${dayFilterClause}

      UNION ALL

      SELECT
        day,
        condition_id,
        token_id,
        maker AS address,
        if(taker_side = 'buy', toFloat64(usdc_amount) / 1e6, -toFloat64(usdc_amount) / 1e6) AS usdc_delta_usd,
        if(taker_side = 'buy', -toFloat64(token_amount) / 1e6, toFloat64(token_amount) / 1e6) AS token_delta_usd
      FROM pm_trade_fct
      ${dayFilterClause}
    ) flows
    GROUP BY day, condition_id, token_id, address
  `;
}

const PM_TRADER_MARKET_ROLLUP_DAILY_SELECT_SQL = buildPmTraderMarketRollupDailySelectSql();

const SEMANTIC_TABLE_SPECS: SqlSpec[] = [
  {
    name: "pm_market_dim",
    sql: `
      CREATE TABLE IF NOT EXISTS pm_market_dim (
        market_id String,
        condition_id String,
        question String,
        slug String,
        category String,
        category_norm String,
        tags String,
        active UInt8,
        closed UInt8,
        created_at_dt Nullable(DateTime),
        end_date_dt Nullable(DateTime),
        is_up_down_market UInt8,
        interval_minutes UInt16,
        asset_symbol LowCardinality(String),
        asset_family LowCardinality(String),
        event_type LowCardinality(String),
        is_crypto UInt8,
        is_resolved UInt8,
        winning_outcome LowCardinality(String),
        updated_at DateTime
      )
      ENGINE = ReplacingMergeTree(updated_at)
      ORDER BY (condition_id)
    `,
  },
  {
    name: "pm_token_dim",
    sql: `
      CREATE TABLE IF NOT EXISTS pm_token_dim (
        token_id String,
        condition_id String,
        market_id String,
        question String,
        category String,
        category_norm String,
        tags String,
        outcome_index Int32,
        outcome_name String,
        active UInt8,
        closed UInt8,
        created_at_dt Nullable(DateTime),
        end_date_dt Nullable(DateTime),
        updated_at DateTime
      )
      ENGINE = ReplacingMergeTree(updated_at)
      ORDER BY (token_id)
    `,
  },
  {
    name: "pm_resolution_dim",
    sql: `
      CREATE TABLE IF NOT EXISTS pm_resolution_dim (
        token_id String,
        condition_id String,
        won UInt8,
        winning_outcome LowCardinality(String),
        is_resolved UInt8,
        resolved_at Nullable(DateTime),
        updated_at DateTime
      )
      ENGINE = ReplacingMergeTree(updated_at)
      ORDER BY (token_id)
    `,
  },
  {
    name: "pm_trade_fct",
    sql: `
      CREATE TABLE IF NOT EXISTS pm_trade_fct (
        day Date,
        timestamp_dt DateTime,
        block_number UInt64,
        transaction_hash String,
        log_index UInt32,
        order_hash String,
        maker String,
        taker String,
        maker_asset_id String,
        taker_asset_id String,
        maker_amount UInt64,
        taker_amount UInt64,
        fee UInt64,
        token_id String,
        condition_id String,
        market_id String,
        outcome_index Int32,
        outcome_name String,
        taker_side LowCardinality(String),
        usdc_amount UInt64,
        token_amount UInt64,
        price Float64,
        amount Float64,
        volume_usd Float64,
        _contract Nullable(String),
        _fetched_at String
      )
      ENGINE = MergeTree
      PARTITION BY toYYYYMM(day)
      ORDER BY (day, condition_id, token_id, block_number, transaction_hash, log_index)
    `,
  },
  {
    name: "pm_trader_market_rollup_daily",
    sql: `
      CREATE TABLE IF NOT EXISTS pm_trader_market_rollup_daily (
        day Date,
        condition_id String,
        token_id String,
        address String,
        trade_count UInt64,
        total_volume_usd Float64,
        usdc_flow_usd Float64,
        token_flow_usd Float64
      )
      ENGINE = SummingMergeTree
      PARTITION BY toYYYYMM(day)
      ORDER BY (day, condition_id, address, token_id)
    `,
  },
];

const SEMANTIC_INGEST_MV_SPECS: SqlSpec[] = [
  {
    name: "mv_pm_market_dim_ingest",
    sql: `
      CREATE MATERIALIZED VIEW IF NOT EXISTS mv_pm_market_dim_ingest
      TO pm_market_dim
      AS
      ${PM_MARKET_DIM_SELECT_SQL}
    `,
  },
  {
    name: "mv_pm_token_dim_ingest",
    sql: `
      CREATE MATERIALIZED VIEW IF NOT EXISTS mv_pm_token_dim_ingest
      TO pm_token_dim
      AS
      ${PM_TOKEN_DIM_SELECT_SQL}
    `,
  },
  {
    name: "mv_pm_resolution_dim_ingest",
    sql: `
      CREATE MATERIALIZED VIEW IF NOT EXISTS mv_pm_resolution_dim_ingest
      TO pm_resolution_dim
      AS
      ${PM_RESOLUTION_DIM_SELECT_SQL}
    `,
  },
  {
    name: "mv_pm_trade_fct_ingest",
    sql: `
      CREATE MATERIALIZED VIEW IF NOT EXISTS mv_pm_trade_fct_ingest
      TO pm_trade_fct
      AS
      ${PM_TRADE_FCT_SELECT_SQL}
    `,
  },
  {
    name: "mv_pm_trader_market_rollup_daily_ingest",
    sql: `
      CREATE MATERIALIZED VIEW IF NOT EXISTS mv_pm_trader_market_rollup_daily_ingest
      TO pm_trader_market_rollup_daily
      AS
      ${PM_TRADER_MARKET_ROLLUP_DAILY_SELECT_SQL}
    `,
  },
];

// These are query-layer views. They stay regular views by design to avoid expensive full-history MV builds.
const REGULAR_VIEW_SPECS: SqlSpec[] = [
  {
    name: "mv_daily_volume",
    sql: `
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
  },
  {
    name: "mv_price_distribution",
    sql: `
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
  },
  {
    name: "mv_category_summary",
    sql: `
      CREATE OR REPLACE VIEW mv_category_summary AS
      SELECT
        if(event_ticker = '' OR event_ticker IS NULL, 'independent', extract(event_ticker, '^([A-Z0-9]+)')) AS category,
        status,
        count() AS market_count,
        sum(volume) AS total_volume
      FROM kalshi_markets
      GROUP BY category, status
    `,
  },
  {
    name: "mv_kalshi_calibration",
    sql: `
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
  },
  {
    name: "mv_pm_market_tokens",
    sql: `
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
  },
  {
    name: "mv_pm_trades_base",
    sql: `
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
        toFloat64(if(maker_asset_id = '0', maker_amount, taker_amount)) / nullIf(toFloat64(if(maker_asset_id = '0', taker_amount, maker_amount)), 0) AS price,
        toFloat64(if(maker_asset_id = '0', taker_amount, maker_amount)) / 1e6 AS amount,
        toFloat64(if(maker_asset_id = '0', maker_amount, taker_amount)) / 1e6 AS volume_usd,
        if(maker_asset_id = '0', 'buy', 'sell') AS taker_side
      FROM polymarket_trades
      WHERE maker_asset_id != taker_asset_id
    `,
  },
  {
    name: "mv_pm_trades_enriched",
    sql: `
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
        m.outcome_name AS outcome,
        m.active AS market_active,
        m.closed AS market_closed,
        m.end_date AS market_end_date,
        m.created_at AS market_created_at,
        m.volume AS market_volume,
        m.liquidity AS market_liquidity
      FROM mv_pm_trades_base t
      INNER JOIN mv_pm_market_tokens m ON t.token_id = m.token_id
    `,
  },
  {
    name: "mv_pm_resolved_markets",
    sql: `
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
  },
  {
    name: "mv_pm_token_lookup",
    sql: `
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
  },
  {
    name: "mv_pm_calibration",
    sql: `
      CREATE OR REPLACE VIEW mv_pm_calibration AS
      WITH trades_priced AS (
        SELECT
          toDate(parseDateTimeBestEffortOrNull(t.timestamp)) AS day,
          round(usdc_amount * 100.0 / nullIf(token_amount, 0)) AS price,
          lk.won AS won
        FROM mv_pm_trades_base t
        INNER JOIN mv_pm_token_lookup lk ON t.token_id = lk.token_id
        WHERE token_amount > 0
          AND parseDateTimeBestEffortOrNull(t.timestamp) IS NOT NULL
      ),
      agg AS (
        SELECT
          day,
          toInt32(price) AS price,
          count() AS trade_count,
          sum(if(won = 1, 1, 0)) AS won_trades
        FROM trades_priced
        WHERE price BETWEEN 1 AND 99
        GROUP BY day, price
      )
      SELECT
        day,
        day AS resolution_date,
        price,
        toFloat64(price) / 100.0 AS bucket,
        toFloat64(price) / 100.0 AS probability,
        trade_count,
        trade_count AS total_count,
        trade_count AS \`count\`,
        won_trades,
        won_trades AS yes_wins,
        won_trades AS wins
      FROM agg
      ORDER BY day, price
    `,
  },
  {
    name: "mv_pm_daily_volume",
    sql: `
      CREATE OR REPLACE VIEW mv_pm_daily_volume AS
      SELECT
        day,
        sum(trade_count) AS trade_count,
        sum(volume_usdc) AS volume_usdc,
        sum(volume_usd) AS volume_usd
      FROM pm_daily_volume_rollup
      GROUP BY day
      ORDER BY day
    `,
  },
  {
    name: "mv_pm_trader_market_summary",
    sql: `
      CREATE OR REPLACE VIEW mv_pm_trader_market_summary AS
      SELECT
        r.address,
        ifNull(m.market_id, '') AS market_id,
        r.condition_id,
        ifNull(m.question, '') AS question,
        ifNull(nullIf(m.category, ''), m.category_norm) AS category,
        ifNull(m.tags, '[]') AS tags,
        sum(r.trade_count) AS trade_count,
        sum(r.total_volume_usd) AS total_volume_usd,
        sum(
          if(
            rd.token_id != '',
            if(rd.won = 1, r.token_flow_usd, 0) + r.usdc_flow_usd,
            0
          )
        ) AS realized_pnl_usd
      FROM pm_trader_market_rollup_daily r
      LEFT JOIN (
        SELECT
          condition_id,
          any(market_id) AS market_id,
          any(question) AS question,
          any(category) AS category,
          any(category_norm) AS category_norm,
          any(tags) AS tags
        FROM pm_market_dim
        GROUP BY condition_id
      ) m ON r.condition_id = m.condition_id
      LEFT JOIN (
        SELECT
          token_id,
          any(won) AS won
        FROM pm_resolution_dim
        WHERE is_resolved = 1
        GROUP BY token_id
      ) rd ON r.token_id = rd.token_id
      GROUP BY
        r.address,
        ifNull(m.market_id, ''),
        r.condition_id,
        ifNull(m.question, ''),
        ifNull(nullIf(m.category, ''), m.category_norm),
        ifNull(m.tags, '[]')
    `,
  },
  {
    name: "mv_pm_trader_summary",
    sql: `
      CREATE OR REPLACE VIEW mv_pm_trader_summary AS
      SELECT
        address,
        sum(trade_count) AS trade_count,
        sum(total_volume_usd) AS total_volume_usd,
        sum(realized_pnl_usd) AS realized_pnl_usd
      FROM mv_pm_trader_market_summary
      GROUP BY address
    `,
  },
  {
    name: "mv_pm_market_summary",
    sql: `
      CREATE OR REPLACE VIEW mv_pm_market_summary AS
      SELECT
        if(closed = 1, 'closed', if(active = 1, 'active', 'inactive')) AS status,
        count() AS market_count,
        sum(volume) AS total_volume,
        sum(liquidity) AS total_liquidity
      FROM polymarket_markets
      GROUP BY status
    `,
  },
];

function escapeSqlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function isTruthy(value: string): boolean {
  return value === "1" || value === "true" || value === "yes";
}

function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function formatDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

async function getExistingObjectEngine(name: string): Promise<string | null> {
  const rows = await clickhouseService.query<ExistingObjectRow>(
    `
      SELECT engine
      FROM system.tables
      WHERE database = currentDatabase()
        AND name = '${escapeSqlString(name)}'
      LIMIT 1
    `,
  );

  return rows.length > 0 ? rows[0].engine : null;
}

async function dropObjectIfExists(name: string): Promise<void> {
  const engine = await getExistingObjectEngine(name);
  if (!engine) return;

  if (engine.includes("View")) {
    await clickhouseService.execute(`DROP VIEW IF EXISTS ${name}`);
    return;
  }

  await clickhouseService.execute(`DROP TABLE IF EXISTS ${name}`);
}

async function ensureRegularViewSlot(name: string): Promise<void> {
  const engine = await getExistingObjectEngine(name);
  if (!engine || engine === "View") return;
  console.log(`Replacing ${name} (engine=${engine}) with regular view...`);
  await dropObjectIfExists(name);
}

async function ensureTableSlot(name: string): Promise<void> {
  const engine = await getExistingObjectEngine(name);
  if (!engine || (!engine.includes("View") && engine !== "MaterializedView")) return;
  console.log(`Replacing ${name} (engine=${engine}) with table...`);
  await dropObjectIfExists(name);
}

async function ensureMaterializedViewSlot(name: string): Promise<void> {
  const engine = await getExistingObjectEngine(name);
  if (!engine || engine === "MaterializedView") return;
  console.log(`Replacing ${name} (engine=${engine}) with materialized view...`);
  await dropObjectIfExists(name);
}

async function executeSpec(spec: SqlSpec, kind: string): Promise<void> {
  console.log(`Ensuring ${kind} ${spec.name}...`);
  try {
    await clickhouseService.execute(spec.sql);
  } catch (err) {
    throw new Error(
      `Failed to build ${kind} ${spec.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function runDailyVolumeRollupBackfill(
  rebuild: boolean,
  skipIfNotEmpty: boolean,
): Promise<void> {
  const rowCount = await clickhouseService.query<CountRow>("SELECT count() AS c FROM pm_daily_volume_rollup");
  const currentRows = rowCount.length > 0 ? Number(rowCount[0].c) : 0;

  if (skipIfNotEmpty && currentRows > 0) {
    console.log(
      `Skipping pm_daily_volume_rollup backfill (existing rows=${currentRows}). Use rebuild/force to repopulate.`,
    );
    return;
  }

  if (rebuild) {
    await clickhouseService.execute("TRUNCATE TABLE pm_daily_volume_rollup");
  }

  console.log("Backfilling pm_daily_volume_rollup from polymarket_trades...");
  await clickhouseService.execute(
    `
      INSERT INTO pm_daily_volume_rollup
      WITH parseDateTimeBestEffortOrNull(timestamp) AS parsed_ts
      SELECT
        toDate(assumeNotNull(parsed_ts)) AS day,
        count() AS trade_count,
        sum(toUInt64(if(maker_asset_id = '0', maker_amount, taker_amount))) AS volume_usdc,
        sum(toFloat64(if(maker_asset_id = '0', maker_amount, taker_amount)) / 1e6) AS volume_usd
      FROM polymarket_trades
      WHERE maker_asset_id != taker_asset_id
        AND parsed_ts IS NOT NULL
      GROUP BY day
    `,
  );
}

async function runPmSemanticLayerBackfill(
  rebuild: boolean,
  skipIfNotEmpty: boolean,
): Promise<void> {
  const rollupIngestSpec = SEMANTIC_INGEST_MV_SPECS.find(
    (spec) => spec.name === "mv_pm_trader_market_rollup_daily_ingest",
  );
  if (!rollupIngestSpec) {
    throw new Error("Missing semantic ingest spec for mv_pm_trader_market_rollup_daily_ingest");
  }

  let rollupIngestDropped = false;
  if (await getExistingObjectEngine(rollupIngestSpec.name)) {
    console.log(
      "Temporarily disabling mv_pm_trader_market_rollup_daily_ingest during pm_trade_fct backfill to avoid OOM.",
    );
    await dropObjectIfExists(rollupIngestSpec.name);
    rollupIngestDropped = true;
  }

  try {
    const rowCount = await clickhouseService.query<CountRow>("SELECT count() AS c FROM pm_trade_fct");
    const currentRows = rowCount.length > 0 ? Number(rowCount[0].c) : 0;

    if (skipIfNotEmpty && currentRows > 0) {
      console.log(
        `Skipping pm semantic layer backfill (pm_trade_fct rows=${currentRows}). Use rebuild/force to repopulate.`,
      );
      return;
    }

    if (rebuild || !skipIfNotEmpty) {
      await clickhouseService.execute("TRUNCATE TABLE pm_trader_market_rollup_daily");
      await clickhouseService.execute("TRUNCATE TABLE pm_trade_fct");
      await clickhouseService.execute("TRUNCATE TABLE pm_resolution_dim");
      await clickhouseService.execute("TRUNCATE TABLE pm_token_dim");
      await clickhouseService.execute("TRUNCATE TABLE pm_market_dim");
    }

    console.log("Backfilling pm_market_dim from polymarket_markets...");
    await clickhouseService.execute(`INSERT INTO pm_market_dim ${PM_MARKET_DIM_SELECT_SQL}`);

    console.log("Backfilling pm_token_dim from polymarket_markets...");
    await clickhouseService.execute(`INSERT INTO pm_token_dim ${PM_TOKEN_DIM_SELECT_SQL}`);

    console.log("Backfilling pm_resolution_dim from polymarket_markets...");
    await clickhouseService.execute(`INSERT INTO pm_resolution_dim ${PM_RESOLUTION_DIM_SELECT_SQL}`);

    console.log("Backfilling pm_trade_fct from polymarket_trades...");
    await clickhouseService.execute(`INSERT INTO pm_trade_fct ${PM_TRADE_FCT_SELECT_SQL}`);

    console.log("Computing pm_trade_fct day range for windowed rollup backfill...");
    const minDayRows = await clickhouseService.query<DayValueRow>(
      "SELECT day FROM pm_trade_fct ORDER BY day ASC LIMIT 1",
    );
    const maxDayRows = await clickhouseService.query<DayValueRow>(
      "SELECT day FROM pm_trade_fct ORDER BY day DESC LIMIT 1",
    );

    if (minDayRows.length > 0 && maxDayRows.length > 0) {
      const minDay = parseDateOnly(String(minDayRows[0].day));
      const maxDay = parseDateOnly(String(maxDayRows[0].day));
      const totalWindows = Math.max(
        1,
        Math.ceil(
          (maxDay.getTime() - minDay.getTime() + 24 * 60 * 60 * 1000) /
          (PM_SEMANTIC_ROLLUP_WINDOW_DAYS * 24 * 60 * 60 * 1000),
        ),
      );

      console.log(
        `Backfilling pm_trader_market_rollup_daily from pm_trade_fct in ${totalWindows} windows (window_days=${PM_SEMANTIC_ROLLUP_WINDOW_DAYS})...`,
      );

      let windowStart = minDay;
      let windowIndex = 0;
      while (windowStart.getTime() <= maxDay.getTime()) {
        const windowEndExclusive = addDays(windowStart, PM_SEMANTIC_ROLLUP_WINDOW_DAYS);
        const startDay = formatDateOnly(windowStart);
        const endDayExclusive = formatDateOnly(windowEndExclusive);
        const endDayInclusive = formatDateOnly(addDays(windowEndExclusive, -1));
        windowIndex += 1;

        console.log(
          `pm_trader_market_rollup_daily window ${windowIndex}/${totalWindows}: day range ${startDay}..${endDayInclusive}`,
        );

        const dayFilterClause =
          `WHERE day >= toDate('${escapeSqlString(startDay)}') ` +
          `AND day < toDate('${escapeSqlString(endDayExclusive)}')`;
        await clickhouseService.execute(
          `INSERT INTO pm_trader_market_rollup_daily ${buildPmTraderMarketRollupDailySelectSql(dayFilterClause)}`,
        );

        windowStart = windowEndExclusive;
      }
    } else {
      console.log("Skipping pm_trader_market_rollup_daily backfill (pm_trade_fct is empty).");
    }
  } finally {
    if (rollupIngestDropped) {
      await executeSpec(rollupIngestSpec, "semantic ingest materialized view");
    }
  }
}

async function ensureDailyVolumeRollupObjects(rebuild: boolean): Promise<void> {
  const managedNames = [
    ...INGEST_MV_SPECS.map((s) => s.name),
    ...ROLLUP_TABLE_SPECS.map((s) => s.name),
  ];

  if (rebuild) {
    for (const name of managedNames) {
      await dropObjectIfExists(name);
    }
  } else {
    for (const spec of ROLLUP_TABLE_SPECS) {
      await ensureTableSlot(spec.name);
    }
    for (const spec of INGEST_MV_SPECS) {
      await ensureMaterializedViewSlot(spec.name);
    }
  }

  for (const spec of ROLLUP_TABLE_SPECS) {
    await executeSpec(spec, "rollup table");
  }
  for (const spec of INGEST_MV_SPECS) {
    await executeSpec(spec, "ingest materialized view");
  }
}

async function ensurePmSemanticLayerObjects(rebuild: boolean): Promise<void> {
  const managedNames = [
    ...SEMANTIC_INGEST_MV_SPECS.map((s) => s.name),
    ...SEMANTIC_TABLE_SPECS.map((s) => s.name),
  ];

  if (rebuild) {
    for (const name of managedNames) {
      await dropObjectIfExists(name);
    }
  } else {
    for (const spec of SEMANTIC_TABLE_SPECS) {
      await ensureTableSlot(spec.name);
    }
    for (const spec of SEMANTIC_INGEST_MV_SPECS) {
      await ensureMaterializedViewSlot(spec.name);
    }
  }

  for (const spec of SEMANTIC_TABLE_SPECS) {
    await executeSpec(spec, "semantic table");
  }
  for (const spec of SEMANTIC_INGEST_MV_SPECS) {
    await executeSpec(spec, "semantic ingest materialized view");
  }
}

export async function backfillPmDailyVolumeRollup(
  options: DailyVolumeRollupBackfillOptions = {},
): Promise<void> {
  const rebuild = options.rebuild ?? false;
  const ensureObjects = options.ensureObjects ?? true;
  const skipIfNotEmpty = options.skipIfNotEmpty ?? !rebuild;

  if (ensureObjects) {
    await ensureDailyVolumeRollupObjects(rebuild);
  }

  await runDailyVolumeRollupBackfill(rebuild, skipIfNotEmpty);
}

export async function backfillPmSemanticLayer(
  options: PmSemanticLayerBackfillOptions = {},
): Promise<void> {
  const rebuild = options.rebuild ?? false;
  const ensureObjects = options.ensureObjects ?? true;
  const skipIfNotEmpty = options.skipIfNotEmpty ?? !rebuild;

  if (ensureObjects) {
    await ensurePmSemanticLayerObjects(rebuild);
  }

  await runPmSemanticLayerBackfill(rebuild, skipIfNotEmpty);
}

export async function createMaterializedViews() {
  const startedAt = Date.now();
  const rebuild = isTruthy(MV_REBUILD);
  const backfillOnStartup = isTruthy(MV_BACKFILL_ON_STARTUP);
  const canonicalBackfillOnStartup = isTruthy(MV_CANONICAL_BACKFILL_ON_STARTUP);
  console.log(`Ensuring ClickHouse analytics objects (rebuild=${rebuild})...`);

  const managedNames = [
    ...REGULAR_VIEW_SPECS.map((s) => s.name),
    ...INGEST_MV_SPECS.map((s) => s.name),
    ...SEMANTIC_INGEST_MV_SPECS.map((s) => s.name),
    ...ROLLUP_TABLE_SPECS.map((s) => s.name),
    ...SEMANTIC_TABLE_SPECS.map((s) => s.name),
  ];

  if (rebuild) {
    for (const name of managedNames) {
      await dropObjectIfExists(name);
    }
  } else {
    await ensureDailyVolumeRollupObjects(false);
    await ensurePmSemanticLayerObjects(false);
    for (const spec of REGULAR_VIEW_SPECS) {
      await ensureRegularViewSlot(spec.name);
    }
  }

  if (rebuild) {
    await ensureDailyVolumeRollupObjects(true);
    await ensurePmSemanticLayerObjects(true);
  }

  if (backfillOnStartup) {
    await backfillPmDailyVolumeRollup({
      rebuild,
      ensureObjects: false,
      skipIfNotEmpty: !rebuild,
    });
  } else {
    console.log(
      "Skipping pm_daily_volume_rollup backfill on startup (set API_MV_BACKFILL_ON_STARTUP=1 to enable).",
    );
  }

  if (canonicalBackfillOnStartup) {
    await backfillPmSemanticLayer({
      rebuild,
      ensureObjects: false,
      skipIfNotEmpty: !rebuild,
    });
  } else {
    console.log(
      "Skipping pm semantic layer backfill on startup (set API_MV_CANONICAL_BACKFILL_ON_STARTUP=1 to enable).",
    );
  }

  for (const spec of REGULAR_VIEW_SPECS) {
    await executeSpec(spec, "view");
  }

  console.log(`ClickHouse analytics objects ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
}
