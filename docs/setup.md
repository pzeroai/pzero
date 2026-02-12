# Setup Guide

## Prerequisites

- **[Bun](https://bun.sh)** v1.0+
- **An LLM API key** — OpenAI recommended, but any OpenAI-compatible provider works
- **Disk space** for prediction market data (full dataset is ~36GB)

## Installation

```bash
git clone https://github.com/pzeroai/pzero.git
cd p0
bun install
```

## Configuration

```bash
cp .env.example .env
```

Edit `.env`:

| Variable      | Required | Default                   | Description              |
|---------------|----------|---------------------------|--------------------------|
| `LLM_API_KEY` | Yes      | —                         | API key for LLM provider |
| `LLM_BASE_URL`| No       | `https://api.openai.com/v1` | LLM API endpoint       |
| `LLM_MODEL`   | No       | `gpt-4o`                  | Model identifier         |
| `DATA_DIR`    | No       | `./data`                  | Path to parquet data     |

## Data Setup

### Download the Dataset

```bash
bun run setup-data
```

This installs required tools (zstd, aria2c) and downloads ~36GB of prediction market data into `./data/`. Data sourced from [prediction-market-analysis](https://github.com/Jon-Becker/prediction-market-analysis).

### Expected Structure

```
$DATA_DIR/
├── kalshi/
│   ├── markets/        # Kalshi market parquet files
│   └── trades/         # Kalshi trade parquet files
└── polymarket/
    ├── markets/        # Polymarket market parquet files
    ├── trades/         # CTF Exchange trade parquet files
    ├── blocks/         # Polygon block timestamp parquet files
    └── legacy_trades/  # Pre-2022 FPMM trade parquet files (optional)
```

### Data Schemas

**Kalshi Markets** — one row per prediction market contract

| Column       | Type           | Description                              |
|--------------|----------------|------------------------------------------|
| ticker       | string         | Unique market ID (e.g. PRES-2024-DJT)   |
| event_ticker | string         | Parent event ID, used for categorization |
| title        | string         | Human-readable market title              |
| status       | string         | "open", "closed", or "finalized"         |
| yes_bid/ask  | int (nullable) | Best bid/ask for Yes (cents, 1-99)       |
| no_bid/ask   | int (nullable) | Best bid/ask for No (cents, 1-99)        |
| last_price   | int (nullable) | Last traded price (cents, 1-99)          |
| volume       | int            | Total contracts traded                   |
| result       | string         | "yes", "no", or "" if unresolved         |

**Kalshi Trades** — one row per trade execution (~72M rows)

| Column       | Type     | Description                        |
|--------------|----------|------------------------------------|
| trade_id     | string   | Unique trade identifier            |
| ticker       | string   | Market ticker                      |
| count        | int      | Number of contracts traded         |
| yes_price    | int      | Yes price (cents, 1-99)            |
| no_price     | int      | No price (cents), always 100 - yes |
| taker_side   | string   | "yes" or "no"                      |
| created_time | datetime | When the trade occurred            |

**Polymarket Markets** — one row per market

| Column         | Type           | Description                              |
|----------------|----------------|------------------------------------------|
| id             | string         | Market ID                                |
| question       | string         | Market question                          |
| outcomes       | string (JSON)  | Outcome names, e.g. `["Yes","No"]`       |
| outcome_prices | string (JSON)  | Final prices per outcome                 |
| clob_token_ids | string (JSON)  | Token IDs mapping to outcomes            |
| volume         | float          | Total volume in USD                      |
| active         | bool           | Is market active                         |
| closed         | bool           | Is market closed                         |

**Polymarket Trades** — CTF Exchange OrderFilled events (~40K+ files)

| Column         | Type   | Description                                |
|----------------|--------|--------------------------------------------|
| block_number   | int    | Polygon block number                       |
| maker_asset_id | int    | Asset ID maker provided (0 = USDC)         |
| taker_asset_id | int    | Asset ID taker provided                    |
| maker_amount   | int    | Amount maker gave (6 decimals for USDC)    |
| taker_amount   | int    | Amount taker gave (6 decimals)             |

**Polymarket Blocks** — block number to timestamp mapping

| Column       | Type   | Description              |
|--------------|--------|--------------------------|
| block_number | int    | Polygon block number     |
| timestamp    | string | ISO 8601 timestamp       |

Note: Kalshi prices are in **cents** (1-99). Polymarket prices are **decimals** (0-1). Both represent implied probability.

## LLM Configuration

### OpenAI (default)

```bash
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o
```

### Anthropic (via LiteLLM)

```bash
# Start LiteLLM proxy with Docker
cd litellm-proxy
docker run -d \
  --name litellm \
  -p 4000:4000 \
  -v $(pwd)/config.yaml:/app/config.yaml \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  ghcr.io/berriai/litellm:main-latest \
  --config /app/config.yaml --port 4000

# In .env:
LLM_BASE_URL=http://localhost:4000/v1
LLM_MODEL=claude-sonnet-4-5-20250929
LLM_API_KEY=sk-litellm-master-key
```

See [LiteLLM Docker Quick Start](https://docs.litellm.ai/docs/proxy/docker_quick_start) for more options.

### Ollama (local, free)

```bash
# Start Ollama
ollama run llama3

# In .env:
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=llama3
LLM_API_KEY=ollama
```

Local models may produce lower quality SQL. GPT-4o or Claude Sonnet recommended.

## Running

### Development

```bash
bun run dev          # Start both API (3001) + web (5173)
bun run dev:api      # API only
bun run dev:web      # Web only
```

Open [http://localhost:5173](http://localhost:5173)

### Production Build

```bash
bun run build        # Build web frontend to dist/
```

### Tests

```bash
bun run test         # Run all tests
```

## Troubleshooting

**"Skipping materialized views" on startup**
Normal if data directory is empty. The API starts but queries against raw parquet will fail.

**LLM errors**
Check `LLM_API_KEY` and `LLM_BASE_URL` in `.env`. Errors are logged to stdout.

**DuckDB out of memory**
The full dataset requires significant RAM. Try a subset of data or close other applications.

**Port already in use**
API uses 3001, web uses 5173. Kill existing processes or change ports in the respective configs.
