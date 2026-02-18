import duckdb from "duckdb";
import path from "path";
import { mkdirSync } from "fs";

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dir, "../../../../data"));
const DUCKDB_PATH = process.env.DUCKDB_PATH || ":memory:";
const DUCKDB_MEMORY_LIMIT = process.env.DUCKDB_MEMORY_LIMIT || "1GB";
const DUCKDB_TEMP_DIR = process.env.DUCKDB_TEMP_DIR || path.join(DATA_DIR, ".duckdb_tmp");
const DUCKDB_THREADS = Number(process.env.DUCKDB_THREADS || "0");

const KALSHI_DIR = path.join(DATA_DIR, "kalshi");
const MARKETS_DIR = path.join(KALSHI_DIR, "markets");
const TRADES_DIR = path.join(KALSHI_DIR, "trades");

const POLYMARKET_DIR = path.join(DATA_DIR, "polymarket");
const PM_MARKETS_DIR = path.join(POLYMARKET_DIR, "markets");
const PM_TRADES_DIR = path.join(POLYMARKET_DIR, "trades");
const PM_LEGACY_TRADES_DIR = path.join(POLYMARKET_DIR, "legacy_trades");
const PM_BLOCKS_DIR = path.join(POLYMARKET_DIR, "blocks");

export { MARKETS_DIR, TRADES_DIR, PM_MARKETS_DIR, PM_TRADES_DIR, PM_LEGACY_TRADES_DIR, PM_BLOCKS_DIR };

function convertSpecialTypes(obj: unknown): unknown {
  if (typeof obj === "bigint") return Number(obj);
  if (obj instanceof Date) return obj.toISOString().slice(0, 10);
  if (Array.isArray(obj)) return obj.map(convertSpecialTypes);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = convertSpecialTypes(v);
    }
    return result;
  }
  return obj;
}

class DuckDBService {
  private db: duckdb.Database;
  private conn: duckdb.Connection;
  private initPromise: Promise<void>;

  constructor() {
    this.db = new duckdb.Database(DUCKDB_PATH);
    this.conn = this.db.connect();
    this.initPromise = this.initialize();
  }

  private run(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.conn as any).run(sql, (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private async initialize(): Promise<void> {
    try {
      mkdirSync(DUCKDB_TEMP_DIR, { recursive: true });
      await this.run(`SET temp_directory='${DUCKDB_TEMP_DIR.replace(/'/g, "''")}'`);
    } catch (err) {
      console.warn("DuckDB temp_directory setup skipped:", (err as Error).message);
    }

    try {
      await this.run(`SET memory_limit='${DUCKDB_MEMORY_LIMIT.replace(/'/g, "''")}'`);
    } catch (err) {
      console.warn("DuckDB memory_limit setup skipped:", (err as Error).message);
    }

    if (Number.isFinite(DUCKDB_THREADS) && DUCKDB_THREADS > 0) {
      try {
        await this.run(`SET threads=${Math.floor(DUCKDB_THREADS)}`);
      } catch (err) {
        console.warn("DuckDB threads setup skipped:", (err as Error).message);
      }
    }
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    timeout = 120_000,
  ): Promise<T[]> {
    await this.initPromise;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Query timed out after 2 minutes"));
      }, timeout);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.conn as any).all(sql, (err: Error | null, rows: T[]) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(convertSpecialTypes(rows) as T[]);
      });
    });
  }

  resolvePaths(sql: string): string {
    return sql
      .replace(/\{markets_dir\}/g, MARKETS_DIR)
      .replace(/\{trades_dir\}/g, TRADES_DIR)
      .replace(/\{pm_markets_dir\}/g, PM_MARKETS_DIR)
      .replace(/\{pm_trades_dir\}/g, PM_TRADES_DIR)
      .replace(/\{pm_legacy_trades_dir\}/g, PM_LEGACY_TRADES_DIR)
      .replace(/\{pm_blocks_dir\}/g, PM_BLOCKS_DIR);
  }
}

export const duckdbService = new DuckDBService();
