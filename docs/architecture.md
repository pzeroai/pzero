# Architecture

## Overview

p[0] is a two-tier application: a React SPA communicates with a Fastify API that orchestrates LLM inference and DuckDB query execution against parquet files from Kalshi and Polymarket.

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
[4] Path resolution ({markets_dir} -> filesystem path)
    |
    v
[5] Query cache check (5-min TTL, keyed on resolved SQL)
    |
    v  (miss)
[6] DuckDB executes SQL against parquet files (30s timeout)
    |
    v  (error? -> retry with LLM once)
[7] Response: { data, chart, sql, explanation }
    |
    v
Frontend renders chart widget
```

## DuckDB + Parquet

DuckDB runs in-memory, reading parquet files directly from disk. There is no ETL or data loading step — DuckDB scans parquet on demand.

Materialized views are created at server startup for common aggregations (daily volume, price distribution, category summary, calibration). These live as in-memory tables for the server's lifetime and are preferred over raw scans for performance.

### Data Directory

```
$DATA_DIR/
├── kalshi/
│   ├── markets/       # *.parquet — one row per market contract
│   └── trades/        # *.parquet — one row per trade (~72M rows)
└── polymarket/
    ├── markets/       # *.parquet — one row per market
    ├── trades/        # *.parquet — CTF Exchange OrderFilled events (~40K files)
    ├── blocks/        # *.parquet — Polygon block number -> timestamp
    └── legacy_trades/ # *.parquet — pre-2022 FPMM trades
```

## Caching

Two-layer LRU caching in `apps/api/src/services/cache.ts`:

| Cache     | Key                    | TTL    | Max Entries | Prevents            |
|-----------|------------------------|--------|-------------|----------------------|
| LLM cache | hash(message + history)| 10 min | 100         | Redundant LLM calls  |
| SQL cache | hash(resolved SQL)     | 5 min  | 200         | Redundant DB queries |

Uses `Bun.hash()` for fast hashing.

## LLM Integration

- **Client**: OpenAI SDK with configurable `baseURL` — works with any OpenAI-compatible API
- **System prompt**: Contains full schema documentation for all data sources + materialized views (~266 lines)
- **Response format**: JSON mode via `response_format: { type: "json_object" }`
- **Self-correction**: On SQL error, the error message is fed back to the LLM for one retry attempt

### Provider Support

| Provider   | Setup                           |
|------------|---------------------------------|
| OpenAI     | Direct — set `LLM_API_KEY`      |
| Anthropic  | Via LiteLLM proxy               |
| Gemini     | Via LiteLLM proxy               |
| Ollama     | Direct — local, free            |
| Any other  | Any OpenAI-compatible endpoint  |

## SQL Validation

`apps/api/src/lib/sql-validator.ts` enforces:

- Queries must start with `SELECT` or `WITH`
- Blocked keywords: INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, COPY, EXPORT, ATTACH, DETACH, LOAD, INSTALL, CALL, EXECUTE, PRAGMA
- Word-boundary matching prevents false positives on column names (e.g. `updated_at` is fine)

## Chart Rendering Pipeline

1. LLM specifies chart config: `{ type, x, y, series?, title, xLabel, yLabel }`
2. `ChartRenderer` selects the appropriate Recharts component
3. For series data (multi-line, grouped bars): data is pivoted client-side
4. Smart date formatting auto-detects granularity:
   - `>365 days` span: quarterly (2024Q1)
   - `>60 days` span: monthly (Jan 2024)
   - `<60 days` span: daily (Jan 15)
5. Number formatting uses K/M/B abbreviations on all Y-axes and tooltips

Supported chart types: `bar`, `line`, `scatter`, `area`, `pie`, `histogram`

## Widget System

State is managed by Zustand in `apps/web/src/store/dashboard.ts`.

Each widget stores:
- `id` — unique identifier
- `sql` — the executed query
- `data` — query results
- `chart` — chart configuration
- `explanation` — human-readable description
- `layout` — grid position `{ x, y, w, h }`

### Widget Interactions

- **Grid**: `react-grid-layout` with 12 columns, 80px row height, drag and resize
- **Refine**: Inline editing panel per widget with full conversation history
- **Natural language targeting**: Users can reference widgets by name or position in the main chat. Widget context is injected into LLM messages so it knows the current dashboard state.

## Materialized Views

Created at startup in `apps/api/src/services/materialized-views.ts`:

**Kalshi**:
- `mv_daily_volume` — daily trade count, contract count, notional volume
- `mv_price_distribution` — trade count by price and taker side
- `mv_category_summary` — market counts and volume by category
- `mv_kalshi_calibration` — win rate by price paid by taker

**Polymarket**:
- `mv_pm_daily_volume` — daily trade count and USDC volume
- `mv_pm_market_summary` — market counts by status
- `mv_pm_resolved_markets` — resolved markets with token IDs and winning outcome
- `mv_pm_token_lookup` — flat token-to-outcome mapping for fast joins
- `mv_pm_calibration` — win rate by normalized price bucket (1-99)
