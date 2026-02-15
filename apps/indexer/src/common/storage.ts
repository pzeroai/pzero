import duckdb from "duckdb";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { Glob } from "bun";

const CHUNK_SIZE = 10_000;

export class ParquetStorage {
  private db: duckdb.Database;
  private conn: duckdb.Connection;
  private nextChunkIndex: number | null = null;
  private stageDir: string;

  constructor(private dataDir: string, private filePrefix: string = "data") {
    mkdirSync(dataDir, { recursive: true });
    this.stageDir = join(dataDir, ".staging");
    mkdirSync(this.stageDir, { recursive: true });
    this.db = new duckdb.Database(":memory:");
    this.conn = this.db.connect();
  }

  private query(sql: string): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this.conn as any).all(sql, (err: Error | null, rows: Record<string, unknown>[]) => {
        if (err) reject(err);
        else resolve(rows ?? []);
      });
    });
  }

  async loadExistingKeys(keyColumn: string): Promise<Set<string>> {
    const pattern = join(this.dataDir, `${this.filePrefix}_*.parquet`);
    const glob = new Glob(`${this.filePrefix}_*.parquet`);
    const files = [...glob.scanSync(this.dataDir)];
    if (files.length === 0) return new Set();

    try {
      const rows = await this.query(
        `SELECT DISTINCT "${keyColumn}" AS k FROM '${pattern}'`,
      );
      return new Set(rows.map((r) => String(r.k)));
    } catch {
      return new Set();
    }
  }

  private computeNextChunkIndex(): number {
    const glob = new Glob(`${this.filePrefix}_*.parquet`);
    const files = [...glob.scanSync(this.dataDir)];
    if (files.length === 0) return 0;

    let maxIdx = 0;
    for (const f of files) {
      const parts = f.replace(".parquet", "").split("_");
      const idx = parseInt(parts[1], 10);
      if (!isNaN(idx) && idx > maxIdx) maxIdx = idx;
    }
    return maxIdx + CHUNK_SIZE;
  }

  getNextChunkIndex(): number {
    if (this.nextChunkIndex == null) {
      this.nextChunkIndex = this.computeNextChunkIndex();
    }
    const chunkIdx = this.nextChunkIndex;
    this.nextChunkIndex += CHUNK_SIZE;
    return chunkIdx;
  }

  async writeChunk(records: Record<string, unknown>[]): Promise<void> {
    if (records.length === 0) return;

    const chunkIdx = this.getNextChunkIndex();
    const chunkPath = join(this.dataDir, `${this.filePrefix}_${chunkIdx}_${chunkIdx + CHUNK_SIZE}.parquet`);
    const stagePath = join(
      this.stageDir,
      `${this.filePrefix}_${chunkIdx}_${Date.now()}_${Math.random().toString(16).slice(2)}.ndjson`,
    );

    // Keep stable schema behavior by using columns from the first record.
    const columns = Object.keys(records[0]);
    const ndjson = records
      .map((row) => {
        const normalized: Record<string, unknown> = {};
        for (const col of columns) {
          const value = row[col];
          if (value === undefined || value === null) normalized[col] = null;
          else if (value instanceof Date) normalized[col] = value.toISOString();
          else normalized[col] = value;
        }
        return JSON.stringify(normalized);
      })
      .join("\n");

    writeFileSync(stagePath, ndjson, "utf-8");
    try {
      await this.query(
        `COPY (SELECT * FROM read_json_auto('${stagePath}', format='newline_delimited')) TO '${chunkPath}' (FORMAT PARQUET)`,
      );
    } finally {
      rmSync(stagePath, { force: true });
    }
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

  hasData(): boolean {
    const glob = new Glob(`${this.filePrefix}_*.parquet`);
    return [...glob.scanSync(this.dataDir)].length > 0;
  }

  async queryScalar<T = unknown>(sql: string): Promise<T | null> {
    const pattern = join(this.dataDir, `${this.filePrefix}_*.parquet`);
    try {
      const rows = await this.query(sql.replace("{files}", `'${pattern}'`));
      if (rows.length === 0) return null;
      const val = Object.values(rows[0])[0];
      return (val ?? null) as T | null;
    } catch {
      return null;
    }
  }

  /**
   * Check which keys from a small batch already exist in parquet files.
   * Much cheaper than loading ALL keys into memory.
   */
  async findExistingKeys(keyColumn: string, keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const pattern = join(this.dataDir, `${this.filePrefix}_*.parquet`);
    const glob = new Glob(`${this.filePrefix}_*.parquet`);
    const files = [...glob.scanSync(this.dataDir)];
    if (files.length === 0) return new Set();

    try {
      const inList = keys.map((k) => `'${k.replace(/'/g, "''")}'`).join(",");
      const rows = await this.query(
        `SELECT DISTINCT "${keyColumn}" AS k FROM '${pattern}' WHERE "${keyColumn}" IN (${inList})`,
      );
      return new Set(rows.map((r) => String(r.k)));
    } catch {
      return new Set();
    }
  }

  async getMaxValue(column: string): Promise<number | null> {
    const result = await this.queryScalar<number>(
      `SELECT MAX("${column}") AS v FROM {files}`,
    );
    return result != null ? Number(result) : null;
  }

  async getRowCount(): Promise<number> {
    const result = await this.queryScalar<number>(
      `SELECT COUNT(*) AS v FROM {files}`,
    );
    return result != null ? Number(result) : 0;
  }

  close(): void {
    // Intentionally skip db.close() — DuckDB's NAPI cleanup crashes Bun.
    // process.exit(0) in cli.ts handles teardown safely.
  }
}
