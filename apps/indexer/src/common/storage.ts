import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { CLICKHOUSE_TABLES, type ClickHouseTableName } from "@p0/shared";

const CHUNK_SIZE = 10_000;
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://localhost:8123";
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || "default";
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || "";
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE || "default";

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe identifier: ${identifier}`);
  }
  return `\`${identifier}\``;
}

function normalizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) {
      normalized[key] = null;
      continue;
    }
    if (value instanceof Date) {
      normalized[key] = value.toISOString();
      continue;
    }
    if (typeof value === "boolean") {
      normalized[key] = value ? 1 : 0;
      continue;
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      normalized[key] = null;
      continue;
    }
    normalized[key] = value;
  }
  return normalized;
}

export class ClickHouseStorage {
  private client: ClickHouseClient;
  private initPromise: Promise<void>;

  constructor(private tableName: ClickHouseTableName) {
    this.client = createClient({
      url: CLICKHOUSE_URL,
      username: CLICKHOUSE_USER,
      password: CLICKHOUSE_PASSWORD,
      database: CLICKHOUSE_DATABASE,
    });
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    const ddl = CLICKHOUSE_TABLES[this.tableName];
    await this.client.command({
      query: ddl,
      abort_signal: AbortSignal.timeout(180_000),
    });
  }

  private async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    await this.initPromise;
    const result = await this.client.query({
      query: sql,
      format: "JSONEachRow",
      abort_signal: AbortSignal.timeout(180_000),
    });
    return await result.json<T>();
  }

  async loadExistingKeys(keyColumn: string): Promise<Set<string>> {
    const col = quoteIdentifier(keyColumn);
    const rows = await this.query<{ k: unknown }>(
      `SELECT DISTINCT ${col} AS k FROM ${this.tableName}`,
    );
    return new Set(rows.map((row) => String(row.k)));
  }

  async writeChunk(records: Record<string, unknown>[]): Promise<void> {
    if (records.length === 0) return;
    await this.initPromise;
    const values = records.map(normalizeRecord);
    await this.client.insert({
      table: this.tableName,
      values,
      format: "JSONEachRow",
      abort_signal: AbortSignal.timeout(180_000),
    });
  }

  async writeBatched(records: Record<string, unknown>[]): Promise<number> {
    let total = 0;
    while (records.length >= CHUNK_SIZE) {
      await this.writeChunk(records.slice(0, CHUNK_SIZE));
      records = records.slice(CHUNK_SIZE);
      total += CHUNK_SIZE;
    }
    if (records.length > 0) {
      await this.writeChunk(records);
      total += records.length;
    }
    return total;
  }

  async hasData(): Promise<boolean> {
    const rows = await this.query<{ c: number | string }>(
      `SELECT count(*) AS c FROM ${this.tableName} LIMIT 1`,
    );
    if (rows.length === 0) return false;
    return Number(rows[0].c) > 0;
  }

  async queryScalar<T = unknown>(sql: string): Promise<T | null> {
    try {
      const query = sql.replace("{files}", this.tableName);
      const rows = await this.query<Record<string, unknown>>(query);
      if (rows.length === 0) return null;
      const value = Object.values(rows[0])[0];
      return (value ?? null) as T | null;
    } catch {
      return null;
    }
  }

  async findExistingKeys(keyColumn: string, keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const col = quoteIdentifier(keyColumn);
    const inList = keys.map((k) => sqlQuote(k)).join(",");

    try {
      const rows = await this.query<{ k: unknown }>(
        `SELECT DISTINCT ${col} AS k FROM ${this.tableName} WHERE ${col} IN (${inList})`,
      );
      return new Set(rows.map((row) => String(row.k)));
    } catch {
      return new Set();
    }
  }

  async getMaxValue(column: string): Promise<number | null> {
    const col = quoteIdentifier(column);
    const result = await this.queryScalar<number | string>(
      `SELECT max(${col}) AS v FROM ${this.tableName}`,
    );
    return result != null ? Number(result) : null;
  }

  async getRowCount(): Promise<number> {
    const result = await this.queryScalar<number | string>(
      `SELECT count(*) AS v FROM ${this.tableName}`,
    );
    return result != null ? Number(result) : 0;
  }

  close(): void {
    void this.client.close();
  }
}
