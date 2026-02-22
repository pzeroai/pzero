export type SqlGuardrailCode =
  | "LARGE_SCAN_REQUIRES_TIME_BOUND"
  | "DETAIL_QUERY_REQUIRES_LIMIT"
  | "UNBOUNDED_TEXT_SCAN"
  | "BROAD_JOIN_NO_TIME_BOUND";

export type SqlGuardrailResult =
  | { valid: true }
  | { valid: false; code: SqlGuardrailCode; reason: string };

const LARGE_SCAN_FACT_PATTERN = /\b(?:from|join)\s+(?:polymarket_trades|polymarket_legacy_trades|kalshi_trades|mv_pm_trades_base|mv_pm_trades_enriched|mv_pm_trader_market_summary|pm_trade_fct|pm_trader_market_rollup_daily)\b/i;
const TEXT_SCAN_PATTERN = /\b(?:ilike\s+'%|positioncaseinsensitive\s*\(|match\s*\()/i;
const TEMPORAL_BOUND_PATTERN = /\b(?:day|timestamp_dt|timestamp|created_time|end_date|open_time|close_time|resolution_date)\b\s*(?:>=|<=|>|<|=|between)\s*(?:toDateTime\(|toDate\(|parseDateTimeBestEffortOrNull\(|'\d{4}-\d{2}-\d{2}|now\(\)|today\(\)|yesterday\()/i;
const HAS_LIMIT_PATTERN = /\blimit\s+\d+/i;
const AGGREGATE_PATTERN = /\b(group\s+by|count\s*\(|sum\s*\(|avg\s*\(|min\s*\(|max\s*\(|uniq\w*\s*\(|quantile\w*\s*\(|arg(?:max|min)\s*\()/i;

function countJoins(sql: string): number {
  const matches = sql.match(/\bjoin\b/gi);
  return matches ? matches.length : 0;
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

export function enforceSqlGuardrails(sql: string): SqlGuardrailResult {
  const query = normalize(sql);
  const hasLargeScanFact = LARGE_SCAN_FACT_PATTERN.test(query);
  const hasTemporalBound = TEMPORAL_BOUND_PATTERN.test(query);
  const hasLimit = HAS_LIMIT_PATTERN.test(query);
  const hasAggregate = AGGREGATE_PATTERN.test(query);
  const hasTextScan = TEXT_SCAN_PATTERN.test(query);
  const joinCount = countJoins(query);

  if (hasLargeScanFact && hasTextScan && !hasTemporalBound) {
    return {
      valid: false,
      code: "UNBOUNDED_TEXT_SCAN",
      reason:
        "Unbounded text/regex scan on large fact tables is blocked; add a bounded time range and tighter filters.",
    };
  }

  if (hasLargeScanFact && joinCount >= 2 && !hasTemporalBound) {
    return {
      valid: false,
      code: "BROAD_JOIN_NO_TIME_BOUND",
      reason:
        "Broad joins on large fact tables require explicit bounded time filters before execution.",
    };
  }

  if (hasLargeScanFact && !hasTemporalBound) {
    return {
      valid: false,
      code: "LARGE_SCAN_REQUIRES_TIME_BOUND",
      reason:
        "Large fact-table queries must include an explicit bounded time window (e.g. day/timestamp/end_date range).",
    };
  }

  if (!hasAggregate && !hasLimit) {
    return {
      valid: false,
      code: "DETAIL_QUERY_REQUIRES_LIMIT",
      reason: "Non-aggregated/detail queries must include an explicit LIMIT.",
    };
  }

  return { valid: true };
}
