const BLOCKED_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "ALTER",
  "CREATE",
  "COPY",
  "EXPORT",
  "ATTACH",
  "DETACH",
  "LOAD",
  "INSTALL",
  "CALL",
  "EXECUTE",
  "PRAGMA",
];

export function validateSQL(sql: string): { valid: boolean; error?: string } {
  const upper = sql.toUpperCase().trim();

  if (!upper.startsWith("SELECT") && !upper.startsWith("WITH")) {
    return { valid: false, error: "Query must be a SELECT statement" };
  }

  for (const keyword of BLOCKED_KEYWORDS) {
    const regex = new RegExp(`\\b${keyword}\\b`, "i");
    if (regex.test(sql)) {
      return { valid: false, error: `Blocked keyword: ${keyword}` };
    }
  }

  return { valid: true };
}
