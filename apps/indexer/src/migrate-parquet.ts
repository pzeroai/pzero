import { createClient } from "@clickhouse/client";
import { createReadStream, existsSync, readdirSync } from "fs";
import { join } from "path";
import { CLICKHOUSE_TABLES, type ClickHouseTableName } from "@p0/shared";
import { DATA_DIR } from "./common/paths";

interface MigrationSource {
  table: ClickHouseTableName;
  relativeDir: string;
}

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://localhost:8123";
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || "default";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || "";
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE || "default";

const SOURCES: MigrationSource[] = [
  { table: "kalshi_markets", relativeDir: "kalshi/markets" },
  { table: "kalshi_trades", relativeDir: "kalshi/trades" },
  { table: "polymarket_markets", relativeDir: "polymarket/markets" },
  { table: "polymarket_trades", relativeDir: "polymarket/trades" },
  { table: "polymarket_blocks", relativeDir: "polymarket/blocks" },
  { table: "polymarket_legacy_trades", relativeDir: "polymarket/legacy_trades" },
];

interface CliOptions {
  truncate: boolean;
  continueOnError: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  return {
    truncate: argv.includes("--truncate"),
    continueOnError: argv.includes("--continue-on-error"),
  };
}

function listParquetFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".parquet"))
    .filter((name) => !name.startsWith("._"))
    .sort();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const client = createClient({
    url: CLICKHOUSE_URL,
    username: CLICKHOUSE_USER,
    password: CLICKHOUSE_PASSWORD,
    database: CLICKHOUSE_DATABASE,
  });

  let insertedFiles = 0;
  let skippedDirs = 0;

  try {
    console.log(`Migrating parquet to ClickHouse from DATA_DIR=${DATA_DIR}`);
    console.log(
      `Target ClickHouse: ${CLICKHOUSE_URL} (db=${CLICKHOUSE_DATABASE}, user=${CLICKHOUSE_USER})`,
    );
    if (options.truncate) {
      console.log("Mode: truncate destination tables before insert");
    }
    if (options.continueOnError) {
      console.log("Mode: continue on file-level errors");
    }

    for (const source of SOURCES) {
      const ddl = CLICKHOUSE_TABLES[source.table];
      await client.command({
        query: ddl,
        abort_signal: AbortSignal.timeout(180_000),
      });
      if (options.truncate) {
        await client.command({
          query: `TRUNCATE TABLE ${source.table}`,
          abort_signal: AbortSignal.timeout(180_000),
        });
      }
    }

    for (const source of SOURCES) {
      const dir = join(DATA_DIR, source.relativeDir);
      const files = listParquetFiles(dir);
      if (files.length === 0) {
        skippedDirs++;
        console.log(`[skip] ${source.table}: no parquet files in ${dir}`);
        continue;
      }

      console.log(`[start] ${source.table}: ${files.length} file(s) from ${dir}`);
      let tableInserted = 0;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const filePath = join(dir, file);

        try {
          await client.insert({
            table: source.table,
            values: createReadStream(filePath),
            format: "Parquet",
            clickhouse_settings: {
              input_format_parquet_allow_missing_columns: 1,
              input_format_skip_unknown_fields: 1,
            },
            abort_signal: AbortSignal.timeout(240_000),
          });
          insertedFiles++;
          tableInserted++;
        } catch (err) {
          const message = `[error] ${source.table} file ${filePath}: ${String(err)}`;
          if (!options.continueOnError) {
            throw new Error(message);
          }
          console.error(message);
        }

        if ((i + 1) % 100 === 0 || i + 1 === files.length) {
          console.log(`[progress] ${source.table}: ${i + 1}/${files.length} files`);
        }
      }

      console.log(`[done] ${source.table}: inserted ${tableInserted}/${files.length} file(s)`);
    }

    console.log(`Migration complete: inserted ${insertedFiles} parquet file(s), skipped_dirs=${skippedDirs}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
