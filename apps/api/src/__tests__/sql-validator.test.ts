import { describe, test, expect } from "bun:test";
import { validateSQL } from "../lib/sql-validator";

describe("validateSQL", () => {
  test("accepts valid SELECT statements", () => {
    expect(validateSQL("SELECT * FROM table1")).toEqual({ valid: true });
    expect(validateSQL("SELECT count(*) FROM 'path/*.parquet'")).toEqual({ valid: true });
  });

  test("accepts WITH (CTE) statements", () => {
    expect(validateSQL("WITH cte AS (SELECT 1) SELECT * FROM cte")).toEqual({ valid: true });
  });

  test("is case-insensitive for SELECT/WITH prefix", () => {
    expect(validateSQL("select * from t")).toEqual({ valid: true });
    expect(validateSQL("with x as (select 1) select * from x")).toEqual({ valid: true });
  });

  test("rejects non-SELECT statements", () => {
    const result = validateSQL("INSERT INTO t VALUES (1)");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Query must be a SELECT statement");
  });

  test("rejects empty string", () => {
    expect(validateSQL("").valid).toBe(false);
  });

  test("blocks dangerous keywords", () => {
    const dangerous = [
      "SELECT * FROM t; DROP TABLE t",
      "SELECT * FROM t; DELETE FROM t",
      "SELECT * FROM t; INSERT INTO t VALUES (1)",
      "SELECT * FROM t; UPDATE t SET x = 1",
      "SELECT * FROM t; ALTER TABLE t ADD COLUMN x INT",
      "SELECT * FROM t; CREATE TABLE t2 (x INT)",
      "SELECT * FROM t; COPY t TO 'file.csv'",
      "SELECT * FROM t; EXPORT DATABASE '/tmp'",
      "SELECT * FROM t; ATTACH 'db.duckdb'",
      "SELECT * FROM t; LOAD httpfs",
      "SELECT * FROM t; INSTALL httpfs",
      "SELECT * FROM t; PRAGMA memory_limit",
    ];

    for (const sql of dangerous) {
      const result = validateSQL(sql);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Blocked keyword/);
    }
  });

  test("does not false-positive on column names containing blocked substrings", () => {
    // "updated_at" contains "update" but not as a word boundary
    expect(validateSQL("SELECT updated_at FROM t")).toEqual({ valid: true });
    expect(validateSQL("SELECT created_time FROM t")).toEqual({ valid: true });
    // "execution_id" contains "execute"
    expect(validateSQL("SELECT execution_id FROM t")).toEqual({ valid: true });
  });

  test("trims whitespace before checking prefix", () => {
    expect(validateSQL("   SELECT 1")).toEqual({ valid: true });
    expect(validateSQL("  WITH x AS (SELECT 1) SELECT * FROM x")).toEqual({ valid: true });
  });
});
