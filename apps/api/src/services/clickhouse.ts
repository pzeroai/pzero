import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { CLICKHOUSE_TABLE_ORDER, CLICKHOUSE_TABLES, type ClickHouseTableName } from "@p0/shared";

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://localhost:8123";
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || "default";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || "";
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE || "default";

class ClickHouseService {
  private client: ClickHouseClient;
  private initPromise: Promise<void>;

  constructor() {
    this.client = createClient({
      url: CLICKHOUSE_URL,
      username: CLICKHOUSE_USER,
      password: CLICKHOUSE_PASSWORD,
      database: CLICKHOUSE_DATABASE,
    });
    this.initPromise = this.initialize();
  }

  private async command(sql: string, timeout = 120_000): Promise<void> {
    await this.client.command({
      query: sql,
      abort_signal: AbortSignal.timeout(timeout),
    });
  }

  private async initialize(): Promise<void> {
    for (const tableName of CLICKHOUSE_TABLE_ORDER) {
      await this.ensureTable(tableName);
    }
  }

  async ensureTable(tableName: ClickHouseTableName): Promise<void> {
    const ddl = CLICKHOUSE_TABLES[tableName];
    await this.command(ddl, 180_000);
  }

  async query<T = Record<string, unknown>>(sql: string, timeout = 120_000): Promise<T[]> {
    await this.initPromise;
    const result = await this.client.query({
      query: sql,
      format: "JSONEachRow",
      abort_signal: AbortSignal.timeout(timeout),
    });
    return await result.json<T>();
  }

  async execute(sql: string, timeout = 120_000): Promise<void> {
    await this.initPromise;
    await this.command(sql, timeout);
  }
}

export const clickhouseService = new ClickHouseService();
