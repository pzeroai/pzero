# Contributing to p[0]

## Development Setup

1. Fork and clone the repo
2. Install dependencies:
   ```bash
   bun install
   ```
3. Copy the environment file:
   ```bash
   cp .env.example .env
   ```
4. Set your `LLM_API_KEY` in `.env`
5. Configure ClickHouse credentials + `POLYGON_RPC` in `.env` (see [Setup Guide](docs/setup.md))
6. Start the dev servers:
   ```bash
   bun run dev
   ```

## Code Style

- TypeScript with strict mode throughout
- Tailwind CSS 4 — brutalist aesthetic, terminal green (#22c55e), zero border radius
- Zustand for state management
- Bun runtime — use Bun APIs where available (`Bun.hash`, `bun:test`)

## Making Changes

### API (`apps/api/`)

- Routes go in `src/routes/`
- Database access through `clickhouseService` in `src/services/clickhouse.ts`
- SQL validation rules in `src/lib/sql-validator.ts`
- LLM system prompt in `src/lib/system-prompt.ts`
- Run tests: `bun test apps/api/src/__tests__/`

### Frontend (`apps/web/`)

- Components in `src/components/`
- State in `src/store/dashboard.ts`
- API calls through `src/lib/api.ts`

### Shared Types (`packages/shared/`)

- Data types in `src/schemas.ts`
- API contract types in `src/api.ts`

## Adding New Chart Types

1. Add the type to `ChartConfig["type"]` in `packages/shared/src/schemas.ts`
2. Add rendering logic in `apps/web/src/components/ChartRenderer.tsx`
3. Update the system prompt in `apps/api/src/lib/system-prompt.ts`

## Adding New Data Sources

1. Add/extend ClickHouse base tables in `packages/shared/src/clickhouse.ts`
2. Update ingestion logic in `apps/indexer/src/`
3. Document schema guidance in `apps/api/src/lib/system-prompt.ts`
4. Optionally add derived views in `apps/api/src/services/materialized-views.ts`

## Pull Requests

1. Create a feature branch from `main`
2. Make your changes
3. Run tests: `bun test apps/api/src/__tests__/`
4. Build check: `bun run build`
5. Open a PR with a clear description
