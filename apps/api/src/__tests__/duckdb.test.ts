import { describe, test, expect } from "bun:test";
import { duckdbService, MARKETS_DIR, TRADES_DIR } from "../services/duckdb";

describe("DuckDBService", () => {
  describe("query", () => {
    test("executes basic SQL and returns rows", async () => {
      const rows = await duckdbService.query("SELECT 1 AS value");
      expect(rows).toEqual([{ value: 1 }]);
    });

    test("handles multiple rows", async () => {
      const rows = await duckdbService.query(
        "SELECT * FROM (VALUES (1, 'a'), (2, 'b')) AS t(id, name)"
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ id: 1, name: "a" });
      expect(rows[1]).toEqual({ id: 2, name: "b" });
    });

    test("rejects on invalid SQL", async () => {
      await expect(duckdbService.query("NOT VALID SQL")).rejects.toThrow();
    });

    test("respects timeout", async () => {
      // A very short timeout on a query that should complete instantly
      // This tests the timeout mechanism doesn't interfere with normal queries
      const rows = await duckdbService.query("SELECT 42 AS n", 1000);
      expect(rows).toEqual([{ n: 42 }]);
    });
  });

  describe("resolvePaths", () => {
    test("replaces {markets_dir} placeholder", () => {
      const sql = "SELECT * FROM '{markets_dir}/*.parquet'";
      const resolved = duckdbService.resolvePaths(sql);
      expect(resolved).toBe(`SELECT * FROM '${MARKETS_DIR}/*.parquet'`);
    });

    test("replaces {trades_dir} placeholder", () => {
      const sql = "SELECT * FROM '{trades_dir}/*.parquet'";
      const resolved = duckdbService.resolvePaths(sql);
      expect(resolved).toBe(`SELECT * FROM '${TRADES_DIR}/*.parquet'`);
    });

    test("replaces multiple occurrences", () => {
      const sql =
        "SELECT * FROM '{markets_dir}/*.parquet' m JOIN '{trades_dir}/*.parquet' t ON m.ticker = t.ticker";
      const resolved = duckdbService.resolvePaths(sql);
      expect(resolved).toContain(MARKETS_DIR);
      expect(resolved).toContain(TRADES_DIR);
      expect(resolved).not.toContain("{markets_dir}");
      expect(resolved).not.toContain("{trades_dir}");
    });

    test("returns sql unchanged if no placeholders", () => {
      const sql = "SELECT 1";
      expect(duckdbService.resolvePaths(sql)).toBe(sql);
    });
  });
});
