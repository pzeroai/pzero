import { describe, expect, test } from "bun:test";
import { enforceSqlGuardrails } from "../lib/sql-guardrails";

describe("enforceSqlGuardrails", () => {
  test("rejects large fact scan without time bound", () => {
    const result = enforceSqlGuardrails("SELECT count() FROM mv_pm_trades_base");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("LARGE_SCAN_REQUIRES_TIME_BOUND");
    }
  });

  test("rejects detail query without limit", () => {
    const result = enforceSqlGuardrails("SELECT address FROM mv_pm_trader_summary");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.code).toBe("DETAIL_QUERY_REQUIRES_LIMIT");
    }
  });

  test("allows bounded aggregate on large fact", () => {
    const result = enforceSqlGuardrails(
      "SELECT day, sum(volume_usd) FROM mv_pm_daily_volume WHERE day >= toDate('2025-12-01') AND day < toDate('2026-01-01') GROUP BY day ORDER BY day",
    );
    expect(result).toEqual({ valid: true });
  });
});
