export type ClickHouseTableName =
  | "kalshi_markets"
  | "kalshi_trades"
  | "polymarket_markets"
  | "polymarket_trades"
  | "polymarket_blocks"
  | "polymarket_legacy_trades";

export const CLICKHOUSE_TABLES: Record<ClickHouseTableName, string> = {
  kalshi_markets: `
    CREATE TABLE IF NOT EXISTS kalshi_markets (
      ticker String,
      event_ticker String,
      market_type String,
      title String,
      yes_sub_title String,
      no_sub_title String,
      status String,
      yes_bid Nullable(Int32),
      yes_ask Nullable(Int32),
      no_bid Nullable(Int32),
      no_ask Nullable(Int32),
      last_price Nullable(Int32),
      volume Int64,
      volume_24h Int64,
      open_interest Int64,
      result String,
      created_time Nullable(String),
      open_time Nullable(String),
      close_time Nullable(String),
      _fetched_at String
    )
    ENGINE = MergeTree
    ORDER BY (ticker)
  `,
  kalshi_trades: `
    CREATE TABLE IF NOT EXISTS kalshi_trades (
      trade_id String,
      ticker String,
      count Int64,
      yes_price Int32,
      no_price Int32,
      taker_side String,
      created_time String,
      _fetched_at String
    )
    ENGINE = MergeTree
    ORDER BY (trade_id)
  `,
  polymarket_markets: `
    CREATE TABLE IF NOT EXISTS polymarket_markets (
      id String,
      condition_id String,
      question String,
      slug String,
      outcomes String,
      outcome_prices String,
      clob_token_ids String,
      volume Float64,
      liquidity Float64,
      active UInt8,
      closed UInt8,
      end_date Nullable(String),
      created_at Nullable(String),
      category Nullable(String),
      tags String,
      description Nullable(String),
      image Nullable(String),
      icon Nullable(String),
      _fetched_at String
    )
    ENGINE = MergeTree
    ORDER BY (id)
  `,
  polymarket_trades: `
    CREATE TABLE IF NOT EXISTS polymarket_trades (
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
      timestamp Nullable(String),
      _contract Nullable(String),
      _fetched_at String
    )
    ENGINE = MergeTree
    ORDER BY (block_number, transaction_hash, log_index)
  `,
  polymarket_blocks: `
    CREATE TABLE IF NOT EXISTS polymarket_blocks (
      block_number UInt64,
      timestamp String,
      _fetched_at Nullable(String)
    )
    ENGINE = MergeTree
    ORDER BY (block_number)
  `,
  polymarket_legacy_trades: `
    CREATE TABLE IF NOT EXISTS polymarket_legacy_trades (
      block_number UInt64,
      transaction_hash String,
      log_index UInt32,
      fpmm_address String,
      trader String,
      amount String,
      fee_amount String,
      outcome_index UInt16,
      outcome_tokens String,
      is_buy UInt8,
      timestamp Nullable(String),
      _fetched_at String
    )
    ENGINE = MergeTree
    ORDER BY (block_number, transaction_hash, log_index, fpmm_address)
  `,
};

export const CLICKHOUSE_TABLE_ORDER: ClickHouseTableName[] = [
  "kalshi_markets",
  "kalshi_trades",
  "polymarket_markets",
  "polymarket_trades",
  "polymarket_blocks",
  "polymarket_legacy_trades",
];
