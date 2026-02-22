export type QueryExecutionErrorKind = "transport" | "semantic_sql" | "unknown";

const TRANSPORT_PATTERNS: RegExp[] = [
  /socket connection was closed unexpectedly/i,
  /socket hang up/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /timeout error/i,
  /fetch failed/i,
  /network/i,
  /connection refused/i,
  /connection terminated/i,
  /the user aborted a request/i,
];

const SEMANTIC_SQL_PATTERNS: RegExp[] = [
  /unknown expression/i,
  /unknown identifier/i,
  /unknown expression or function identifier/i,
  /unknown_identifier/i,
  /unknown_table/i,
  /unknown_database/i,
  /syntax_error/i,
  /aggregate function .* found in where/i,
  /illegal_aggregation/i,
  /not_an_aggregate/i,
  /type_mismatch/i,
  /number_of_arguments_doesnt_match/i,
  /cannot_parse_text/i,
  /ambiguous_identifier/i,
  /cannot parse/i,
];

export function classifyQueryExecutionError(errorMessage: string): QueryExecutionErrorKind {
  if (TRANSPORT_PATTERNS.some((r) => r.test(errorMessage))) {
    return "transport";
  }
  if (SEMANTIC_SQL_PATTERNS.some((r) => r.test(errorMessage))) {
    return "semantic_sql";
  }
  return "unknown";
}
