# Architecture

## Overview

p[0] is a two-tier application: a React SPA communicates with a Fastify API that orchestrates LLM inference and ClickHouse query execution over Kalshi and Polymarket datasets.

## Data Flow

```
User question
    |
    v
POST /api/query { message, history }
    |
    v
[1] LLM cache check (10-min TTL, keyed on message+history)
    |
    v  (miss)
[2] LLM generates { sql, chart, explanation }
    |
    v
[3] SQL validation (SELECT/WITH only, blocked keywords)
    |
    v
[4] Query cache check (5-min TTL, keyed on SQL)
    |
    v  (miss)
[5] ClickHouse executes SQL
    |
    v  (error? -> retry with LLM once)
[6] Response: { data, chart, sql, explanation }
    |
    v
Frontend renders chart widget
```

## Storage + Ingestion

- **Primary store**: ClickHouse tables (`kalshi_*`, `polymarket_*`)
- **Indexer writes**: API polling + Polygon event ingestion insert directly into ClickHouse
- **Derived views**: Startup creates/replaces analytics views in `apps/api/src/services/materialized-views.ts`
- **Checkpointing**: Indexers still use `DATA_DIR` for cursor/state files only

## Caching

Two-layer LRU caching in `apps/api/src/services/cache.ts`:

| Cache     | Key                    | TTL    | Max Entries | Prevents            |
|-----------|------------------------|--------|-------------|---------------------|
| LLM cache | hash(message + history)| 10 min | 100         | Redundant LLM calls |
| SQL cache | hash(sql)              | 5 min  | 200         | Redundant DB queries|

Uses `Bun.hash()` for fast hashing.

## LLM Integration

- **Client**: OpenAI SDK with configurable `baseURL`
- **System prompt**: Documents ClickHouse tables + views
- **Response format**: JSON mode via `response_format: { type: "json_object" }`
- **Self-correction**: On SQL error, one retry is generated using the error context

## Materialized/Derived Views

Created or replaced at startup in `apps/api/src/services/materialized-views.ts`:

- `mv_daily_volume`
- `mv_price_distribution`
- `mv_category_summary`
- `mv_kalshi_calibration`
- `mv_pm_market_tokens`
- `mv_pm_trades_base`
- `mv_pm_trades_enriched`
- `mv_pm_resolved_markets`
- `mv_pm_token_lookup`
- `mv_pm_calibration`
- `mv_pm_daily_volume`
- `mv_pm_trader_summary`
- `mv_pm_market_summary`
