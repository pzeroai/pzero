import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { CLICKHOUSE_TABLE_ORDER, CLICKHOUSE_TABLES, type ClickHouseTableName } from "@p0/shared";

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://localhost:8123";
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || "default";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || "";
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE || "default";
const CLICKHOUSE_REQUEST_TIMEOUT_MS = (() => {
  const raw = process.env.CLICKHOUSE_REQUEST_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
})();

class ClickHouseService {
  private client: ClickHouseClient;
  private initPromise: Promise<void> | null;

  constructor() {
    this.client = createClient({
      url: CLICKHOUSE_URL,
      username: CLICKHOUSE_USER,
      password: CLICKHOUSE_PASSWORD,
      database: CLICKHOUSE_DATABASE,
      request_timeout: CLICKHOUSE_REQUEST_TIMEOUT_MS,
    });
    this.initPromise = null;
  }

  private async command(sql: string): Promise<void> {
    await this.client.command({ query: sql });
  }

  private async initialize(): Promise<void> {
    for (const tableName of CLICKHOUSE_TABLE_ORDER) {
      await this.ensureTable(tableName);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      // Initialize lazily so importing route modules does not immediately require network access.
      this.initPromise = this.initialize().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    await this.initPromise;
  }

  async ensureTable(tableName: ClickHouseTableName): Promise<void> {
    const ddl = CLICKHOUSE_TABLES[tableName];
    await this.command(ddl);
  }

  async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    await this.ensureInitialized();
    const result = await this.client.query({
      query: sql,
      format: "JSONEachRow",
    });
    return await result.json<T>();
  }

  async execute(sql: string): Promise<void> {
    await this.ensureInitialized();
    await this.command(sql);
  }

  async close(): Promise<void> {
    await this.client.close();
    this.initPromise = null;
  }
}

export const clickhouseService = new ClickHouseService();
